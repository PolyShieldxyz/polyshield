/**
 * Market registry — resolves an on-chain bet to the REAL Polymarket token to trade.
 *
 * THE PROBLEM: the Vault stores `market_id = toFieldSafe(conditionId)` (a lossy BN254
 * reduction) and a synthetic `position_id` — neither is the real Polymarket ERC1155
 * tokenId the CLOB needs. The order builder previously used `event.position_id` as the
 * tokenID, which a real CLOB rejects.
 *
 * THE FIX: periodically mirror the Polymarket market universe (Gamma API), keyed by the
 * SAME `toFieldSafe(conditionId)` the circuit/Vault use, storing the real conditionId and
 * YES/NO clobTokenIds. At bet time the event listener calls resolveToken(market_id,
 * outcome_side) to swap the synthetic id for the real tokenId before submitting the order.
 *
 * Backend-only — no frontend or contract change. Production-only: in mock mode the sync is
 * skipped and resolveToken returns null, so the existing mock-CLOB path is unchanged.
 */

import Database from "better-sqlite3";
import path from "path";
import pino from "pino";

const logger = pino({ name: "market-registry" });

// MUST match the frontend's toFieldSafe (lib/notes.ts) and the circuit field modulus.
const BN254_P =
  0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;

/** conditionId (bytes32 hex) → field-safe key, exactly as the Vault/circuit store it. */
export function toFieldSafe(hex: string): string {
  const reduced = BigInt(hex) % BN254_P;
  return "0x" + reduced.toString(16).padStart(64, "0");
}

const GAMMA = process.env.GAMMA_API_URL ?? "https://gamma-api.polymarket.com";
const DB_PATH = process.env.SETTLEMENT_DB_PATH ?? path.join(process.cwd(), "settlement.db");

let _db: Database.Database | null = null;
function db(): Database.Database {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS market_registry (
      market_id_field TEXT PRIMARY KEY,  -- toFieldSafe(conditionId), matches on-chain market_id
      condition_id    TEXT NOT NULL,     -- real Polymarket conditionId (bytes32)
      yes_token_id    TEXT NOT NULL,     -- real CLOB tokenId for the YES outcome
      no_token_id     TEXT NOT NULL,     -- real CLOB tokenId for the NO outcome
      question        TEXT,
      updated_at      INTEGER NOT NULL
    )
  `);
  // Migration: add end_date (unix seconds) for the settlement poll's resolution-time gate. Older DBs
  // created before this column get it via ALTER; idempotent via the PRAGMA check.
  const hasEndDate = (_db.prepare(`PRAGMA table_info(market_registry)`).all() as Array<{ name: string }>)
    .some((c) => c.name === "end_date");
  if (!hasEndDate) _db.exec(`ALTER TABLE market_registry ADD COLUMN end_date INTEGER`);
  return _db;
}

function parseJsonArray(s: unknown): string[] {
  if (typeof s !== "string") return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

type GammaMarket = {
  conditionId?: string;
  question?: string;
  outcomes?: string;
  clobTokenIds?: string;
  enableOrderBook?: boolean;
  endDate?: string; // ISO 8601; the market's scheduled resolution time
};

/** Parse a Gamma ISO endDate to unix seconds, or null if absent/unparseable. */
function parseEndDate(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

// Binary outcome pairs the vault treats as side 0 (YES) / side 1 (NO). Polymarket's
// short-dated recurring markets use ["Up","Down"] — MUST match the frontend's
// lib/polymarket.ts BINARY_PAIRS so a bet placed on an Up/Down market resolves to the
// correct tokenId here.
const BINARY_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["yes", "no"],
  ["up", "down"],
];

/** Map a Gamma market to a registry row, or null if it isn't a binary (Yes/No or Up/Down) orderbook market. */
function toRow(
  m: GammaMarket,
): { key: string; conditionId: string; yes: string; no: string; question: string; endDate: number | null } | null {
  const cid = (m.conditionId ?? "").toLowerCase();
  if (!cid.startsWith("0x") || cid.length !== 66) return null;
  if (!m.enableOrderBook) return null;
  const outcomes = parseJsonArray(m.outcomes).map((o) => o.toLowerCase());
  if (outcomes.length !== 2) return null;
  let yesIdx = -1;
  let noIdx = -1;
  for (const [a, b] of BINARY_PAIRS) {
    const yi = outcomes.indexOf(a);
    const ni = outcomes.indexOf(b);
    if (yi >= 0 && ni >= 0) {
      yesIdx = yi;
      noIdx = ni;
      break;
    }
  }
  if (yesIdx < 0 || noIdx < 0) return null;
  const tokens = parseJsonArray(m.clobTokenIds);
  const yes = tokens[yesIdx];
  const no = tokens[noIdx];
  if (!yes || !no) return null;
  return { key: toFieldSafe(cid), conditionId: cid, yes, no, question: m.question ?? "", endDate: parseEndDate(m.endDate) };
}

const PAGE = 500;
const MAX_PAGES = 20; // up to 10k markets — well above the active binary universe

/** Paginate one Gamma ordering, upserting binary rows. Returns the number upserted. */
async function syncPages(orderQuery: string, maxPages: number, ts: number): Promise<number> {
  const stmt = db().prepare(`
    INSERT INTO market_registry (market_id_field, condition_id, yes_token_id, no_token_id, question, end_date, updated_at)
    VALUES (@key, @conditionId, @yes, @no, @question, @endDate, @ts)
    ON CONFLICT(market_id_field) DO UPDATE SET
      condition_id = excluded.condition_id,
      yes_token_id = excluded.yes_token_id,
      no_token_id  = excluded.no_token_id,
      question     = excluded.question,
      end_date     = COALESCE(excluded.end_date, market_registry.end_date),
      updated_at   = excluded.updated_at
  `);
  let upserted = 0;
  for (let page = 0; page < maxPages; page++) {
    const offset = page * PAGE;
    const url = `${GAMMA}/markets?closed=false&active=true&limit=${PAGE}&offset=${offset}&${orderQuery}`;
    let data: GammaMarket[];
    try {
      const res = await fetch(url);
      if (!res.ok) {
        logger.warn({ status: res.status, offset }, "gamma page fetch failed — stopping pass");
        break;
      }
      data = (await res.json()) as GammaMarket[];
    } catch (err) {
      logger.warn({ err, offset }, "gamma page fetch threw — stopping pass");
      break;
    }
    if (!Array.isArray(data) || data.length === 0) break;

    const rows = data.map(toRow).filter((r): r is NonNullable<typeof r> => r !== null);
    const tx = db().transaction((items: typeof rows) => {
      for (const r of items) stmt.run({ ...r, ts });
    });
    tx(rows);
    upserted += rows.length;

    if (data.length < PAGE) break; // last page
  }
  return upserted;
}

/**
 * Fetch active binary markets from Gamma and upsert them into the registry. Two passes:
 *  1. volume24hr desc — the deep market universe.
 *  2. endDate asc (from now) — guarantees short-dated/recurring markets (e.g. "Up or Down"
 *     5m/15m/1h) are present so resolveToken can serve a bet on them; these are low-volume
 *     and would otherwise fall past the volume-ordered pages.
 */
export async function syncMarkets(): Promise<number> {
  const ts = Math.floor(Date.now() / 1000);
  const byVolume = await syncPages("order=volume24hr&ascending=false", MAX_PAGES, ts);
  const nowIso = new Date(ts * 1000).toISOString();
  const bySoon = await syncPages(
    `order=endDate&ascending=true&end_date_min=${encodeURIComponent(nowIso)}`,
    4, // up to 2k soonest-resolving — covers the recurring short-term universe
    ts,
  );
  logger.info({ byVolume, bySoon }, "market registry sync complete");
  return byVolume + bySoon;
}

export interface ResolvedToken {
  tokenId: string;
  conditionId: string;
}

/**
 * Resolve an on-chain bet's (market_id, outcome_side) to the real Polymarket tokenId +
 * conditionId. outcome_side: 0 = YES, 1 = NO. Returns null if the market isn't in the
 * registry (caller should fall back / fail the order recoverably).
 */
export function resolveToken(marketIdField: string, outcomeSide: number): ResolvedToken | null {
  const key = (marketIdField ?? "").toLowerCase();
  const row = db()
    .prepare(
      `SELECT condition_id, yes_token_id, no_token_id FROM market_registry WHERE market_id_field = ?`,
    )
    .get(key) as { condition_id: string; yes_token_id: string; no_token_id: string } | undefined;
  if (!row) return null;
  const tokenId = outcomeSide === 0 ? row.yes_token_id : row.no_token_id;
  if (!tokenId) return null;
  return { tokenId, conditionId: row.condition_id };
}

export function registryCount(): number {
  const row = db().prepare(`SELECT COUNT(*) AS n FROM market_registry`).get() as { n: number };
  return row.n;
}

/**
 * Reverse lookup: given the on-chain `market_id` (the field-safe / BN254-reduced key the Vault
 * stores), return the REAL CTF conditionId needed for `ctf.payoutDenominator`, `redeemPositions`
 * and `Vault.resolveMarket`. Returns null if the market was never synced into the registry.
 *
 * The registry is upsert-only (rows are never deleted), so a market that has already RESOLVED —
 * and thus dropped out of Gamma's active list — still has its row here. This is what lets the
 * settlement poll loop recover the raw conditionId for a market that just resolved.
 */
export function conditionIdForKey(marketIdField: string): string | null {
  const key = (marketIdField ?? "").toLowerCase();
  const row = db()
    .prepare(`SELECT condition_id FROM market_registry WHERE market_id_field = ?`)
    .get(key) as { condition_id: string } | undefined;
  return row?.condition_id ?? null;
}

/** Reverse lookup returning both the raw conditionId and the scheduled resolution time (endDate, unix
 * seconds) for the on-chain market_id, or null if the market was never synced. Used to seed and enrich
 * tracked_markets so the settlement poll knows WHEN a market can first resolve. */
export function marketMetaForKey(marketIdField: string): { conditionId: string; endDate: number | null } | null {
  const key = (marketIdField ?? "").toLowerCase();
  const row = db()
    .prepare(`SELECT condition_id, end_date FROM market_registry WHERE market_id_field = ?`)
    .get(key) as { condition_id: string; end_date: number | null } | undefined;
  return row ? { conditionId: row.condition_id, endDate: row.end_date } : null;
}

let _timer: NodeJS.Timeout | null = null;

/**
 * Start the registry sync loop (production only). Runs once immediately, then every
 * `intervalMs` (default 10 min). No-op in mock mode — the mock CLOB accepts the synthetic
 * position_id, so resolveToken returns null and the existing path is used unchanged.
 */
export function startMarketRegistrySync(intervalMs = 10 * 60 * 1000): void {
  const clobHost = process.env.POLY_API_URL ?? "https://clob.polymarket.com";
  const isMock = clobHost.includes("localhost") || clobHost.includes("127.0.0.1");
  if (isMock) {
    logger.info("mock mode — market registry sync disabled (synthetic position_id used)");
    return;
  }
  if (_timer) return;
  const run = () => {
    syncMarkets().catch((err) => logger.error({ err }, "market registry sync failed"));
  };
  run();
  _timer = setInterval(run, intervalMs);
  logger.info({ intervalMs }, "market registry sync started");
}
