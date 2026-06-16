/**
 * Rate-limit- and range-adaptive `queryFilter` paging, shared by every getLogs scan in the signing
 * layer. A metered RPC (e.g. Alchemy free tier) returns HTTP 429 "compute units per second" under a
 * burst of getLogs; the naive "halve the range on any error" strategy makes that WORSE (more, smaller
 * requests). This helper distinguishes the two failure modes:
 *   - rate limit (429 / "compute unit" / "throughput"): exponential backoff, retry the SAME range;
 *   - range/result too large: halve the span and retry;
 *   - a single-block non-rate-limit failure: a genuine RPC error → throw.
 * It also paces successful requests to stay under the per-second cap.
 */

import { ethers } from "ethers";

// Cold-start floor for any getLogs scan — never page below the contracts' deploy block (a from-0
// scan over millions of blocks is rejected / hugely expensive on a metered RPC).
export const DEPLOY_BLOCK = Number(process.env.VAULT_DEPLOY_BLOCK ?? process.env.TREE_DEPLOY_BLOCK ?? "0");
const DEFAULT_CHUNK = Number(process.env.LOG_SCAN_CHUNK ?? "9000");
const REQUEST_DELAY_MS = Number(process.env.LOG_SCAN_DELAY_MS ?? "250");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True for a 429 / compute-units / rate-limit error (retry same range with backoff), as opposed to
 * a range/result-too-large limit (recover by halving). */
export function isRateLimit(err: unknown): boolean {
  const e = err as { code?: unknown; error?: { code?: unknown; message?: unknown }; shortMessage?: unknown; message?: unknown };
  const code = e?.error?.code ?? e?.code;
  const msg = String(e?.error?.message ?? e?.shortMessage ?? e?.message ?? "").toLowerCase();
  return code === 429 || code === -32005 || msg.includes("compute unit") || msg.includes("rate limit") ||
    msg.includes("too many requests") || msg.includes("429") || msg.includes("throughput");
}

/**
 * A JsonRpcProvider that transparently retries rate-limit (429) errors on EVERY RPC method —
 * eth_call, eth_sendRawTransaction, eth_getTransactionReceipt (tx.wait), eth_getLogs, etc. A metered
 * RPC (Alchemy free tier) 429s under load, and an UNCAUGHT 429 from a tx/receipt call previously
 * crashed the whole signing layer. All provider operations funnel through `send()`, so wrapping it
 * here covers them. Range/result-too-large errors are NOT retried (they aren't rate limits and would
 * loop forever) — callers that page logs handle those via queryFilterChunked.
 */
export class RetryingJsonRpcProvider extends ethers.JsonRpcProvider {
  // `staticNetwork: true` makes ethers detect the chain ONCE and then treat it as fixed. Without it,
  // ethers re-issues `eth_chainId` to re-validate the network around operations (tx population, fee
  // estimation, etc.) — a steady stream of redundant calls on an always-on signing layer. The chain
  // never changes under us, so caching it is correct and removes that traffic.
  constructor(
    url?: string | ethers.FetchRequest,
    network?: ethers.Networkish,
    options?: ethers.JsonRpcApiProviderOptions,
  ) {
    super(url, network, { staticNetwork: true, ...options });
  }

  async send(method: string, params: Array<unknown> | Record<string, unknown>): Promise<unknown> {
    let attempt = 0;
    for (;;) {
      try {
        return await super.send(method, params);
      } catch (err) {
        if (isRateLimit(err) && attempt < 8) {
          attempt++;
          await sleep(Math.min(8_000, 300 * 2 ** attempt)); // exponential backoff, capped
          continue;
        }
        throw err;
      }
    }
  }
}

export async function queryFilterChunked(
  contract: ethers.Contract,
  filter: ethers.DeferredTopicFilter,
  fromBlock: number,
  toBlock: number,
  startChunk = DEFAULT_CHUNK,
): Promise<(ethers.Log | ethers.EventLog)[]> {
  const out: (ethers.Log | ethers.EventLog)[] = [];
  let from = Math.max(0, fromBlock);
  let chunk = Math.max(1, startChunk);
  while (from <= toBlock) {
    const to = Math.min(from + chunk - 1, toBlock);
    try {
      out.push(...(await contract.queryFilter(filter, from, to)));
      from = to + 1;
      if (from <= toBlock && REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
    } catch (err) {
      // 429s are ALREADY retried inside RetryingJsonRpcProvider — do NOT also retry here. Nested
      // retries compound into a multi-minute hang. Propagate a rate-limit; only SHRINK the span for a
      // genuine range/result-too-large error.
      if (isRateLimit(err)) throw err;
      if (to === from) throw err; // single-block non-rate-limit failure → genuine error
      chunk = Math.max(1, Math.floor(chunk / 2));
    }
  }
  return out;
}
