import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import pino from "pino";
import { submitLimitOrder, submitFAKOrder } from "./orderBuilder";
import { getLimitOrder } from "./limitOrderStore";
import { getAttestation } from "./attestationStore";
import { isOrderTracked } from "./wsFillTracker";
import { resolveToken, marketMetaForKey } from "./marketRegistry";
import { upsertTrackedMarket } from "./trackedMarkets";
import { scanHead, fetchBetAuthorized, BetAuthorizedRecord } from "./vaultEventSource";
import { config } from "./config";

// Persist the scan cursor in the DATA VOLUME (next to settlement.db) so a container recreate doesn't
// reset it to 0 and re-scan the whole history from the deploy block. Falls back to ./data locally.
const STATE_FILE = process.env.EVENT_LISTENER_STATE_FILE
  ?? (process.env.SETTLEMENT_DB_PATH
    ? path.join(path.dirname(process.env.SETTLEMENT_DB_PATH), "event-listener-state.json")
    : path.join(process.cwd(), "data", "event-listener-state.json"));
const SAFETY_BUFFER = 100;
// Cold-start floor for the BetAuthorized scan. A public RPC (publicnode) rejects a
// fromBlock:0→latest getLogs over millions of blocks, so never scan below the vault's deploy
// block. Falls back to TREE_DEPLOY_BLOCK (same Deploy.s.sol run) when VAULT_DEPLOY_BLOCK unset.
const DEPLOY_BLOCK = Number(process.env.VAULT_DEPLOY_BLOCK ?? process.env.TREE_DEPLOY_BLOCK ?? "0");
// Poll cadence for the BetAuthorized scan. publicnode has no eth_newFilter/getFilterChanges
// support (a live `vault.on` subscription dies with "filter not found"), so we poll getLogs.
const EVENT_POLL_MS = Number(process.env.EVENT_POLL_MS ?? "15000");
// Blocks per scan WINDOW for the catch-up. The cursor is persisted after each window so an
// interrupted long scan (the one-time historical catch-up on a tiny-getLogs-limit RPC) resumes
// instead of restarting from the deploy block.
const SCAN_WINDOW = Number(process.env.LOG_SCAN_WINDOW ?? "5000");
// Deep safety re-scan. The forward cursor (lastBlock) only moves forward, so a one-time RPC getLogs
// consistency gap (Ankr can return an incomplete window) advances it PAST an unreturned BetAuthorized
// log → that bet is stranded ACTIVE forever (no order, no JIT funding, user funds stuck). To recover,
// periodically re-scan a wide recent window WITHOUT moving the cursor. Idempotent: the per-bet
// attestation / in-flight / on-chain-record checks below prevent any double-submit.
const DEEP_RESCAN_MS = Number(process.env.DEEP_RESCAN_MS ?? "1800000");        // 30 min
const DEEP_LOOKBACK_BLOCKS = Number(process.env.DEEP_LOOKBACK_BLOCKS ?? "100000"); // ~2.7 days on Polygon
// Nullifiers whose processing we've already STARTED this process-lifetime. Prevents the
// poller from re-submitting an order (especially a resting GTC/GTD that has no terminal
// attestation yet) on a subsequent tick before its attestation lands.
const inFlight = new Set<string>();

/**
 * Is the event listener currently submitting an order for this bet (in THIS process)? A bet enters
 * the set the moment handleBetRecord starts processing it and never leaves (so a re-poll can't
 * double-submit). `/cancel-bet` consults this so it never blind-attests FAILED while a market (FAK)
 * order is mid-submission — that race would let a user reclaim a position the pool actually bought.
 * In-memory only: it covers the live submission window; the durable market_submissions marker
 * (attestationStore) covers the across-restart window.
 */
export function isBetInFlight(nullifier: string): boolean {
  return inFlight.has(nullifier);
}

// BetAuthorized events come from vaultEventSource — the proof-relay's event index when available
// (no per-service getLogs), falling back to a direct chain scan. The cursor/window/deep-sweep logic
// below is unchanged; only the source of the events moved.

function loadLastBlock(): number {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as { lastBlock?: unknown };
    return typeof data.lastBlock === "number" ? data.lastBlock : 0;
  } catch {
    return 0;
  }
}

function saveLastBlock(blockNumber: number): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastBlock: blockNumber }));
}

const logger = pino({ name: "event-listener" });

const VAULT_ABI = [
  // M2: outcome_side now included — avoids per-bet betRecords() RPC during settlement.
  // MUST match the deployed Vault event EXACTLY — FC-14 appended (protocolFee, relayFee). A stale
  // signature changes topic0, so vault.filters.BetAuthorized() matches ZERO logs and every bet is
  // stranded (no order, no JIT funding). The two trailing uint64s don't shift args[0..7].
  "event BetAuthorized(bytes32 indexed nullifier, bytes32 market_id, bytes32 position_id, uint64 expected_shares, uint256 bet_amount, uint64 price, uint8 outcome_side, bytes32 new_commitment, uint64 protocolFee, uint64 relayFee)",
  "function betRecords(bytes32 nullifier) view returns (bytes32 market_id, bytes32 condition_id, bytes32 position_id, uint64 expected_shares, uint64 bet_amount, uint8 outcome_side, uint8 status)",
];

async function processBetEvent(
  nullifier: string,
  market_id: string,
  position_id: string,
  outcome_side: number,
  expected_shares: bigint,
  bet_amount: bigint,
  price: bigint,
  new_commitment: string,
  wallet: ethers.Wallet,
  provider: ethers.JsonRpcProvider
): Promise<void> {
  // Swap the on-chain (field-safe market_id, synthetic position_id) for the REAL Polymarket
  // conditionId + tokenId so the CLOB order targets a live market. In mock mode (registry
  // empty) this falls through to the on-chain ids, preserving the existing mock path.
  let realTokenId = position_id;
  let realConditionId = market_id;
  try {
    const resolved = resolveToken(market_id, outcome_side);
    if (resolved) {
      realTokenId = resolved.tokenId;
      realConditionId = resolved.conditionId;
      logger.info(
        { nullifier, market_id, outcome_side, tokenId: resolved.tokenId },
        "resolved real Polymarket token for bet"
      );
    } else {
      logger.warn(
        { nullifier, market_id, outcome_side },
        "market not in registry — using on-chain ids (order may fail on a real CLOB; recoverable via cancellation credit)"
      );
    }
  } catch (err) {
    logger.warn({ err, nullifier }, "resolveToken threw — using on-chain ids");
  }

  // Persist this market so the settlement poll can resolve it later WITHOUT a historical BetAuthorized
  // log scan (which a pruned RPC refuses with "History has been pruned"). The BetAuthorized log is
  // readable right now (it just landed), so we capture market_id → real conditionId here while we can.
  // Best-effort — a failure must never block order submission.
  try {
    const meta = marketMetaForKey(market_id);
    upsertTrackedMarket(market_id, realConditionId, meta?.endDate ?? null);
  } catch (err) {
    logger.warn({ err, nullifier, market_id }, "failed to persist tracked market (settlement poll may miss it)");
  }

  const orderEvent = {
    nullifier,
    market_id: realConditionId,
    position_id: realTokenId,
    expected_shares,
    bet_amount,
    price,
    new_commitment,
  };

  // If the frontend registered an order-type intent for this nullifier, route accordingly: a
  // resting GTC/GTD limit order (or an explicit FAK, kept as a defensive route). Otherwise default
  // to FAK — the frontend's "Market order": fills what the book offers now, refund the remainder via
  // L3. (submitFOKOrder remains as a legacy primitive but is no longer on the live path.)
  const intent = getLimitOrder(nullifier);
  if (intent) {
    logger.info({ nullifier, order_type: intent.order_type }, "order-type intent found — routing");
    if (intent.order_type === "FAK") {
      await submitFAKOrder(orderEvent, wallet, provider);
    } else {
      await submitLimitOrder(orderEvent, { orderType: intent.order_type, expiration: intent.expiration }, wallet, provider);
    }
    return;
  }

  await submitFAKOrder(orderEvent, wallet, provider);
}

/** Process one BetAuthorized record: dedup, confirm the on-chain bet exists, then submit the order. */
async function handleBetRecord(
  r: BetAuthorizedRecord,
  vault: ethers.Contract,
  wallet: ethers.Wallet,
  provider: ethers.JsonRpcProvider,
): Promise<void> {
  const nullifier = r.nullifier;
  try {
    // FC-9: on-chain status is no longer advanced by report* (those are gone), so an ACTIVE on-chain
    // status no longer means "not yet handled" — the order may already be filled. Dedupe on the
    // off-chain attestation store: a persisted attestation means the order reached a terminal state.
    if (getAttestation(nullifier)) return;
    // Within-process dedup: don't re-submit a bet we've already started handling on a prior tick.
    if (inFlight.has(nullifier)) return;
    // Don't re-submit a resting GTC/GTD limit order that's already tracked (no terminal attestation yet).
    if (isOrderTracked(nullifier)) return;

    // Confirm the bet exists on-chain (bytes32(0) market_id ⇒ no record). A BetAuthorized event only
    // exists for a mined, non-reverted tx, so this is belt-and-suspenders, but cheap and keeps the
    // submit gated on the authoritative on-chain record.
    const rec = await vault.betRecords(nullifier);
    const market_id = rec[0] as string;
    if (!market_id || market_id === ethers.ZeroHash) return;

    inFlight.add(nullifier); // mark before submitting; kept on error to avoid double-submit
    logger.warn({ nullifier }, "event-listener: found un-attested bet — processing");
    await processBetEvent(
      nullifier,
      r.market_id,
      r.position_id,
      r.outcome_side,
      r.expected_shares,
      r.bet_amount,
      r.price,
      r.new_commitment,
      wallet,
      provider,
    );
  } catch (err) {
    logger.error({ err, nullifier }, "event-listener: catchup failed for bet");
  }
}

/**
 * Scan for BetAuthorized events and submit any un-attested order. Events are sourced from the
 * proof-relay event index when available (no per-service getLogs), falling back to a direct chain
 * scan. Handles chain/signing-layer restarts without data loss (idempotent dedup in handleBetRecord).
 */
async function catchUpMissedBets(
  vault: ethers.Contract,
  wallet: ethers.Wallet,
  provider: ethers.JsonRpcProvider,
  opts: { fromOverride?: number; persist?: boolean; label?: string } = {}
): Promise<void> {
  // persist=false (the deep sweep) re-scans a wide window without advancing the forward cursor.
  const persist = opts.persist ?? true;
  logger.info(opts.label ?? "event-listener: scanning for missed BetAuthorized events...");
  try {
    // The head to scan up to + where to read events from. Using the INDEX head (when available) keeps
    // the cursor from advancing past blocks the index hasn't ingested (which would skip a bet).
    const { head, source } = await scanHead(provider);
    let fromBlock: number;
    if (opts.fromOverride !== undefined) {
      // Deep safety sweep: clamp the override to [DEPLOY_BLOCK, head].
      fromBlock = Math.max(DEPLOY_BLOCK, Math.min(opts.fromOverride, head));
      logger.info({ fromBlock, head, source, deep: true }, "event-listener: deep re-scan range");
    } else {
      // API-009: clamp the persisted cursor to [0, head] — a corrupt/oversized lastBlock would
      // otherwise push fromBlock past the head and silently skip the whole scan.
      const rawLastBlock = loadLastBlock();
      const lastBlock = Math.min(Math.max(0, Number(rawLastBlock) || 0), head);
      // Floor at the deploy block so a fresh cursor (lastBlock 0) doesn't scan from genesis.
      fromBlock = Math.max(DEPLOY_BLOCK, lastBlock - SAFETY_BUFFER);
      logger.info({ fromBlock, lastBlock, head, source, rawLastBlock }, "event-listener: catchup scan range");
    }

    // Scan in WINDOWs, persisting the cursor after each, so an interrupted long catch-up RESUMES from
    // the last window instead of restarting from the deploy block.
    let cursor = fromBlock;
    while (cursor <= head) {
      const windowEnd = Math.min(cursor + SCAN_WINDOW - 1, head);
      const { records } = await fetchBetAuthorized(vault, cursor, windowEnd, source === "index");
      if (records.length) logger.info({ count: records.length, from: cursor, to: windowEnd, source }, "event-listener: BetAuthorized events found");

      for (const r of records) {
        await handleBetRecord(r, vault, wallet, provider);
      }
      // Persist progress per WINDOW (the SCANNED HEAD of this window). If a later window throws, the
      // cursor is already saved up to here, so the next tick / a restart resumes.
      if (persist) saveLastBlock(windowEnd);
      cursor = windowEnd + 1;
    }
  } catch (err) {
    logger.error({ err }, "event-listener: catchup scan failed");
  }
}

export function startEventListener(
  provider: ethers.JsonRpcProvider,
  wallet: ethers.Wallet
): void {
  const vault = new ethers.Contract(config.vaultContractAddress, VAULT_ABI, provider);

  // publicnode (and most public RPCs) do not support eth_newFilter/getFilterChanges, so a
  // live `vault.on("BetAuthorized")` subscription silently dies ("filter not found") and no
  // orders are ever submitted. Instead we POLL via queryFilter (getLogs) on an interval.
  // catchUpMissedBets is idempotent (attestation store + in-flight set + on-chain bet-record
  // check), and queryFilter only returns mined logs (≥1 confirmation), so polling both
  // catches up missed bets and handles new ones. A re-entrancy guard prevents overlapping scans.
  // One guard serializes the forward poll AND the deep sweep so they never overlap (they share the
  // provider, and the per-bet dedup is the safety net either way).
  let scanning = false;
  const runScan = async (opts: { fromOverride?: number; persist?: boolean; label?: string } = {}) => {
    if (scanning) return;
    scanning = true;
    try {
      await catchUpMissedBets(vault, wallet, provider, opts);
    } finally {
      scanning = false;
    }
  };

  void runScan(); // initial forward scan immediately
  setInterval(() => void runScan(), EVENT_POLL_MS);

  // Deep safety sweep: recover any bet the forward cursor skipped (RPC getLogs gap). Runs once at
  // startup and on a slow timer; re-scans a wide recent window WITHOUT advancing the cursor.
  const deepSweep = async () => {
    const current = await provider.getBlockNumber().catch(() => 0);
    if (!current) return;
    await runScan({
      fromOverride: current - DEEP_LOOKBACK_BLOCKS,
      persist: false,
      label: "event-listener: deep safety re-scan (cursor-skip recovery)",
    });
  };
  void deepSweep(); // startup sweep — recovers bets stranded before this process started
  setInterval(() => void deepSweep(), DEEP_RESCAN_MS);

  logger.info(
    { vault: config.vaultContractAddress, pollMs: EVENT_POLL_MS, deepRescanMs: DEEP_RESCAN_MS, deepLookback: DEEP_LOOKBACK_BLOCKS },
    "Polling for BetAuthorized events (getLogs; public RPC has no filter support) + deep cursor-skip recovery",
  );
}
