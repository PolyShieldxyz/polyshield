/**
 * Backend index of the Vault's note-lifecycle events, so the frontend can RECOVER a user's notes by
 * fetching from us (one request) instead of each client re-scanning the chain through its own RPC
 * (slow + the Alchemy-free 10-block getLogs cap). Privacy is preserved: we store only the PUBLIC,
 * on-chain events — opaque commitments/nullifiers and anonymous amounts. We do NOT (and cannot) know
 * which notes belong to which wallet; only `Deposited` carries a wallet (deposits are public by
 * design). The client, holding the wallet-derived secret, does all the note↔owner matching locally.
 *
 * Maintained incrementally and persisted (same windowed/cursor/chunk pattern as the merkle cache), so
 * it scans history once and then only new blocks. Shares the proof-relay DB (merkle.db).
 */

import Database from "better-sqlite3";
import { ethers } from "ethers";
import pino from "pino";
import { getLogsChunked } from "./merkle";

const logger = pino({ name: "event-index" });

const POLL_MS = Number(process.env.EVENT_INDEX_POLL_MS ?? process.env.MERKLE_CACHE_POLL_MS ?? "15000");
const CONFIRMATIONS = Number(process.env.MERKLE_CACHE_CONFIRMATIONS ?? "3");
const LOG_CHUNK = Number(process.env.LOG_SCAN_CHUNK ?? "10000");
const SCAN_WINDOW = Number(process.env.MERKLE_SCAN_WINDOW ?? "5000");

// The exact events the frontend recovery replay consumes (must match lib/notes.ts).
const VAULT_EVENTS_ABI = [
  "event Deposited(address indexed depositor, bytes32 commitment, uint256 amount)",
  "event BetAuthorized(bytes32 indexed nullifier, bytes32 market_id, bytes32 position_id, uint64 expected_shares, uint256 bet_amount, uint64 price, uint8 outcome_side, bytes32 new_commitment)",
  "event SettlementCredited(bytes32 indexed nullifier, bytes32 nullifier_of_bet, bytes32 new_commitment)",
  "event BetCancellationCredited(bytes32 indexed nullifier, bytes32 nullifier_of_bet, bytes32 new_commitment)",
  "event NACancellationCredited(bytes32 indexed nullifier, bytes32 nullifier_of_bet, bytes32 new_commitment)",
  "event PartialFillCredited(bytes32 indexed nullifier, bytes32 nullifier_of_bet, bytes32 new_commitment)",
  "event Withdrawn(bytes32 indexed nullifier, address recipient, uint256 amount, bytes32 new_commitment)",
  "event BetSold(bytes32 indexed nullifier_of_bet, uint64 sold_shares, uint64 proceeds)",
  "event PositionClosed(bytes32 indexed nullifier, bytes32 nullifier_of_bet, bytes32 new_commitment, bool fullClose)",
  "event Consolidated(bytes32[4] nullifiers, bytes32 new_commitment)",
  "event MarketResolved(bytes32 indexed market_id, uint64 resolvedAt)",
];
const iface = new ethers.Interface(VAULT_EVENTS_ABI);
const TOPICS: string[] = [];
const NAME_BY_TOPIC = new Map<string, string>();
for (const f of iface.fragments) {
  if (f.type === "event") {
    const ef = f as ethers.EventFragment;
    TOPICS.push(ef.topicHash);
    NAME_BY_TOPIC.set(ef.topicHash, ef.name);
  }
}

/** Serialize a decoded event's args by field name → JSON-safe (bigint→decimal string, others as-is). */
function serializeArgs(name: string, parsed: ethers.LogDescription): Record<string, unknown> {
  const a = parsed.args;
  const hx = (v: unknown) => String(v);
  const num = (v: unknown) => (typeof v === "bigint" ? v.toString() : String(v));
  switch (name) {
    case "Deposited": return { depositor: hx(a.depositor), commitment: hx(a.commitment), amount: num(a.amount) };
    case "BetAuthorized": return { nullifier: hx(a.nullifier), market_id: hx(a.market_id), position_id: hx(a.position_id), expected_shares: num(a.expected_shares), bet_amount: num(a.bet_amount), price: num(a.price), outcome_side: num(a.outcome_side), new_commitment: hx(a.new_commitment) };
    case "SettlementCredited":
    case "BetCancellationCredited":
    case "NACancellationCredited":
    case "PartialFillCredited": return { nullifier: hx(a.nullifier), nullifier_of_bet: hx(a.nullifier_of_bet), new_commitment: hx(a.new_commitment) };
    case "Withdrawn": return { nullifier: hx(a.nullifier), recipient: hx(a.recipient), amount: num(a.amount), new_commitment: hx(a.new_commitment) };
    case "BetSold": return { nullifier_of_bet: hx(a.nullifier_of_bet), sold_shares: num(a.sold_shares), proceeds: num(a.proceeds) };
    case "PositionClosed": return { nullifier: hx(a.nullifier), nullifier_of_bet: hx(a.nullifier_of_bet), new_commitment: hx(a.new_commitment), fullClose: Boolean(a.fullClose) };
    case "Consolidated": return { nullifiers: (a.nullifiers as unknown[]).map(hx), new_commitment: hx(a.new_commitment) };
    case "MarketResolved": return { market_id: hx(a.market_id), resolvedAt: num(a.resolvedAt) };
    default: return {};
  }
}

export interface IndexedEvent {
  type: string;
  blockNumber: number;
  logIndex: number;
  txHash: string;
  args: Record<string, unknown>;
}

export class VaultEventIndex {
  private db: Database.Database | null = null;
  private lastBlock: number;
  private ready = false;

  constructor(
    private provider: ethers.JsonRpcProvider,
    private vaultAddress: string,
    private deployBlock: number,
    dbPath: string | null,
  ) {
    this.lastBlock = Math.max(0, deployBlock - 1);
    if (dbPath) {
      try {
        this.db = new Database(dbPath);
        this.db.pragma("journal_mode = WAL");
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS vault_events (
            type      TEXT NOT NULL,
            block     INTEGER NOT NULL,
            log_index INTEGER NOT NULL,
            tx_hash   TEXT NOT NULL,
            depositor TEXT,            -- lowercased, Deposited only (the ONLY wallet-linked event)
            block_ts  INTEGER,         -- unix seconds (for recovery activity timestamps)
            args_json TEXT NOT NULL,
            PRIMARY KEY (type, block, log_index)
          );
          CREATE INDEX IF NOT EXISTS idx_vault_events_depositor ON vault_events (depositor);
          CREATE TABLE IF NOT EXISTS event_index_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
        `);
        const row = this.db.prepare("SELECT v FROM event_index_meta WHERE k='last_block'").get() as { v: string } | undefined;
        if (row) this.lastBlock = parseInt(row.v, 10);
      } catch (err) {
        logger.error({ err: String(err) }, "event index DB init failed — recovery endpoint disabled");
        this.db = null;
      }
    }
  }

  isReady(): boolean { return this.ready && this.db !== null; }

  private async sync(): Promise<void> {
    if (!this.db) return;
    const head = await this.provider.getBlockNumber();
    const target = head - CONFIRMATIONS;
    if (target <= this.lastBlock) return;

    let cursor = this.lastBlock + 1;
    while (cursor <= target) {
      const windowEnd = Math.min(cursor + SCAN_WINDOW - 1, target);
      const logs = await getLogsChunked(this.provider, { address: this.vaultAddress, topics: [TOPICS] }, cursor, windowEnd, LOG_CHUNK);

      // Resolve block timestamps once per unique block in this window.
      const blocks = [...new Set(logs.map((l) => l.blockNumber))];
      const tsByBlock = new Map<number, number>();
      for (const bn of blocks) {
        try { const b = await this.provider.getBlock(bn); if (b) tsByBlock.set(bn, Number(b.timestamp)); } catch { /* leave unset */ }
      }

      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO vault_events (type, block, log_index, tx_hash, depositor, block_ts, args_json)
         VALUES (@type, @block, @log_index, @tx_hash, @depositor, @block_ts, @args_json)`,
      );
      const tx = this.db.transaction((rows: IndexedEvent[]) => {
        for (const r of rows) {
          insert.run({
            type: r.type, block: r.blockNumber, log_index: r.logIndex, tx_hash: r.txHash,
            depositor: r.type === "Deposited" ? String(r.args.depositor).toLowerCase() : null,
            block_ts: tsByBlock.get(r.blockNumber) ?? null,
            args_json: JSON.stringify(r.args),
          });
        }
      });
      const decoded: IndexedEvent[] = [];
      for (const l of logs) {
        const name = NAME_BY_TOPIC.get(l.topics[0]);
        if (!name) continue;
        const parsed = iface.parseLog({ topics: l.topics as string[], data: l.data });
        if (!parsed) continue;
        decoded.push({ type: name, blockNumber: l.blockNumber, logIndex: l.index, txHash: l.transactionHash, args: serializeArgs(name, parsed) });
      }
      tx(decoded);
      if (decoded.length) logger.info({ from: cursor, to: windowEnd, events: decoded.length }, "event index: indexed events");

      this.lastBlock = windowEnd;
      this.db.prepare("INSERT OR REPLACE INTO event_index_meta (k,v) VALUES ('last_block', ?)").run(String(this.lastBlock));
      cursor = windowEnd + 1;
    }
  }

  /** Recovery payload for a wallet: the wallet's Deposited events + ALL anonymous spend events (the
   * client matches its own by re-deriving commitments/nullifiers from its secret). */
  recoveryData(depositor: string): { deposits: IndexedEvent[]; spends: IndexedEvent[] } {
    if (!this.db) return { deposits: [], spends: [] };
    const dep = depositor.toLowerCase();
    const toEvt = (r: { type: string; block: number; log_index: number; tx_hash: string; args_json: string }): IndexedEvent =>
      ({ type: r.type, blockNumber: r.block, logIndex: r.log_index, txHash: r.tx_hash, args: JSON.parse(r.args_json) });
    const deposits = (this.db.prepare("SELECT type, block, log_index, tx_hash, args_json FROM vault_events WHERE type='Deposited' AND depositor=? ORDER BY block, log_index").all(dep) as never[]).map(toEvt);
    const spends = (this.db.prepare("SELECT type, block, log_index, tx_hash, args_json FROM vault_events WHERE type!='Deposited' ORDER BY block, log_index").all() as never[]).map(toEvt);
    return { deposits, spends };
  }

  /** All indexed events (most recent first), for the public Explorer. Anonymous + public — no
   * wallet linkage. Includes block_ts so the client needn't fetch block timestamps. */
  allEvents(limit = 1000): Array<{ type: string; blockNumber: number; logIndex: number; txHash: string; blockTs: number | null; args: Record<string, unknown> }> {
    if (!this.db) return [];
    const rows = this.db
      .prepare("SELECT type, block, log_index, tx_hash, block_ts, args_json FROM vault_events ORDER BY block DESC, log_index DESC LIMIT ?")
      .all(limit) as Array<{ type: string; block: number; log_index: number; tx_hash: string; block_ts: number | null; args_json: string }>;
    return rows.map((r) => ({ type: r.type, blockNumber: r.block, logIndex: r.log_index, txHash: r.tx_hash, blockTs: r.block_ts, args: JSON.parse(r.args_json) }));
  }

  /** Block timestamps (unix seconds) for the blocks referenced by a recovery payload. */
  blockTimestamps(blocks: number[]): Record<number, number> {
    if (!this.db || blocks.length === 0) return {};
    const out: Record<number, number> = {};
    const stmt = this.db.prepare("SELECT DISTINCT block, block_ts FROM vault_events WHERE block = ? AND block_ts IS NOT NULL");
    for (const b of blocks) { const r = stmt.get(b) as { block: number; block_ts: number } | undefined; if (r) out[r.block] = r.block_ts; }
    return out;
  }

  /** One-shot catch-up (no poll interval) for the resync CLI. Backfills recent events into the DB. */
  async catchUp(): Promise<{ lastBlock: number }> {
    await this.sync();
    this.ready = true;
    return { lastBlock: this.lastBlock };
  }

  async start(): Promise<void> {
    logger.info({ fromBlock: this.lastBlock + 1 }, "event index: starting catch-up scan");
    await this.sync();
    this.ready = true;
    logger.info("event index ready");
    setInterval(() => void this.sync().catch((err) => logger.error({ err: String(err) }, "event index sync failed")), POLL_MS);
  }
}
