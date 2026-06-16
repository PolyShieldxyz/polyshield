/**
 * Source of Vault BetAuthorized events for the signing layer.
 *
 * The proof-relay already maintains an authoritative event index of every Vault event (it relays the
 * txs, so it's always fresh). Rather than have the signing layer re-scan the chain for the SAME logs,
 * it reads them from the relay's index (`/index-head`, `/bet-authorized`). A direct chain `getLogs`
 * scan is the fallback whenever the relay is unset/unreachable/not-ready — so resilience is preserved
 * (the signing layer never depends on the relay to keep submitting orders).
 *
 * Correctness: the scan cursor only ever advances to a head we actually covered. When sourcing from
 * the index we use the INDEX head (≤ chain head), so the cursor can't skip a bet the index hasn't
 * ingested yet; a per-window fall-through to the chain only ever returns a SUPERSET of those blocks,
 * and the consumers dedup, so reprocessing is harmless.
 */
import { ethers } from "ethers";
import pino from "pino";
import { config } from "./config";
import { queryFilterChunked } from "./logScan";

const logger = pino({ name: "vault-event-source" });

const RELAY_URL = (config.proofRelayUrl || "").replace(/\/$/, "");
const FETCH_TIMEOUT_MS = Number(process.env.RELAY_FETCH_TIMEOUT_MS ?? "15000");

/** Normalized BetAuthorized event — produced identically from the relay index or a chain scan. */
export interface BetAuthorizedRecord {
  nullifier: string;
  market_id: string;
  position_id: string;
  expected_shares: bigint;
  bet_amount: bigint;
  price: bigint;
  outcome_side: number;
  new_commitment: string;
  blockNumber: number;
  txHash: string;
}

type RelayEvent = { blockNumber: number; txHash: string; args: Record<string, unknown> };

async function relayGetJson(path: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(`${RELAY_URL}${path}`, { signal: controller.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function recordFromIndex(e: RelayEvent): BetAuthorizedRecord {
  const a = e.args;
  return {
    nullifier: String(a.nullifier),
    market_id: String(a.market_id),
    position_id: String(a.position_id),
    expected_shares: BigInt(String(a.expected_shares)),
    bet_amount: BigInt(String(a.bet_amount)),
    price: BigInt(String(a.price)),
    outcome_side: Number(a.outcome_side),
    new_commitment: String(a.new_commitment),
    blockNumber: e.blockNumber,
    txHash: e.txHash,
  };
}

function recordsFromChainLogs(vault: ethers.Contract, logs: (ethers.Log | ethers.EventLog)[]): BetAuthorizedRecord[] {
  const out: BetAuthorizedRecord[] = [];
  for (const log of logs) {
    const parsed = vault.interface.parseLog({ topics: log.topics as string[], data: log.data });
    if (!parsed) continue;
    out.push({
      nullifier: parsed.args[0] as string,
      market_id: parsed.args[1] as string,
      position_id: parsed.args[2] as string,
      expected_shares: parsed.args[3] as bigint,
      bet_amount: parsed.args[4] as bigint,
      price: parsed.args[5] as bigint,
      outcome_side: Number(parsed.args[6]),
      new_commitment: parsed.args[7] as string,
      blockNumber: log.blockNumber,
      txHash: log.transactionHash,
    });
  }
  return out;
}

/** Index head (highest block the relay's event index has ingested), or null if unavailable/not ready. */
async function indexHead(): Promise<number | null> {
  if (!RELAY_URL) return null;
  try {
    const j = (await relayGetJson("/index-head")) as { head?: unknown; ready?: unknown };
    if (j && j.ready === true && typeof j.head === "number") return j.head;
    return null;
  } catch (err) {
    logger.warn({ err: String(err) }, "proof-relay /index-head unavailable — using chain head");
    return null;
  }
}

/**
 * The on-chain market_ids the relay index has seen a MarketResolved event for — so the settlement
 * resolver can seed its "already resolved" set in ONE call instead of probing Vault.marketResolvedAt
 * per market. Returns null if the relay is unset/unreachable (caller keeps the per-market eth_call).
 */
export async function fetchResolvedMarkets(): Promise<string[] | null> {
  if (!RELAY_URL) return null;
  try {
    const j = (await relayGetJson("/resolved-markets")) as { marketIds?: unknown };
    if (Array.isArray(j.marketIds)) return j.marketIds.map(String);
    return null;
  } catch (err) {
    logger.warn({ err: String(err) }, "proof-relay /resolved-markets unavailable — using per-market marketResolvedAt");
    return null;
  }
}

/**
 * The head to scan up to, and which source to read events from. Prefer the relay index head so the
 * cursor never advances past un-indexed blocks; fall back to the chain head.
 */
export async function scanHead(provider: ethers.JsonRpcProvider): Promise<{ head: number; source: "index" | "chain" }> {
  const h = await indexHead();
  if (h !== null) return { head: h, source: "index" };
  return { head: await provider.getBlockNumber(), source: "chain" };
}

/**
 * BetAuthorized events in [fromBlock, toBlock]. If `preferIndex`, read from the relay index and fall
 * back to a chain scan on any failure; otherwise scan the chain directly. Returns the source used.
 */
export async function fetchBetAuthorized(
  vault: ethers.Contract,
  fromBlock: number,
  toBlock: number,
  preferIndex: boolean,
): Promise<{ records: BetAuthorizedRecord[]; source: "index" | "chain" }> {
  if (preferIndex && RELAY_URL) {
    try {
      const j = (await relayGetJson(`/bet-authorized?fromBlock=${fromBlock}&toBlock=${toBlock}`)) as { events?: RelayEvent[] };
      return { records: (j.events ?? []).map(recordFromIndex), source: "index" };
    } catch (err) {
      logger.warn({ err: String(err), fromBlock, toBlock }, "index BetAuthorized fetch failed — falling back to chain getLogs");
    }
  }
  const logs = await queryFilterChunked(vault, vault.filters.BetAuthorized(), fromBlock, toBlock);
  return { records: recordsFromChainLogs(vault, logs), source: "chain" };
}

/**
 * ALL BetAuthorized events from `fromBlock` to the head — for the redemption pipeline (a resolved
 * market's bets). Reads the whole range from the index in one call (no RPC range limits), falling back
 * to a chunked chain scan.
 */
export async function fetchAllBetAuthorized(
  vault: ethers.Contract,
  provider: ethers.JsonRpcProvider,
  fromBlock: number,
): Promise<BetAuthorizedRecord[]> {
  const head = await indexHead();
  if (head !== null && RELAY_URL) {
    try {
      const j = (await relayGetJson(`/bet-authorized?fromBlock=${fromBlock}&toBlock=${head}`)) as { events?: RelayEvent[] };
      return (j.events ?? []).map(recordFromIndex);
    } catch (err) {
      logger.warn({ err: String(err) }, "index full BetAuthorized fetch failed — falling back to chain getLogs");
    }
  }
  const latest = await provider.getBlockNumber();
  const logs = await queryFilterChunked(vault, vault.filters.BetAuthorized(), fromBlock, latest);
  return recordsFromChainLogs(vault, logs);
}
