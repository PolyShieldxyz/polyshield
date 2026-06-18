/**
 * Off-chain Merkle path computation for the CommitmentMerkleTree contract.
 *
 * Reconstructs the append-only Poseidon Merkle tree from on-chain LeafInserted events,
 * then generates a depth-32 inclusion proof for a given commitment.
 *
 * Hash function: poseidon2(left, right) from poseidon-lite — verified to match
 * the on-chain PoseidonT3.hash([left, right]) and Noir's bn254::hash_2([left, right]).
 */

import { ethers } from "ethers";
import { poseidon2 } from "poseidon-lite";

const TREE_DEPTH = 32;

// Precompute zero subtree hashes: zeros[0] = 0, zeros[i+1] = poseidon2(zeros[i], zeros[i])
function buildZeros(): bigint[] {
  const zeros: bigint[] = [0n];
  for (let i = 0; i < TREE_DEPTH; i++) {
    zeros.push(poseidon2([zeros[i], zeros[i]]));
  }
  return zeros;
}

const ZEROS = buildZeros();

// hex-pad bigint to 0x-prefixed 32-byte hex
function toHex(n: bigint): string {
  return "0x" + n.toString(16).padStart(64, "0");
}

export interface MerkleProof {
  path: string[];       // 32 sibling hashes as 0x-prefixed hex
  pathIndices: number[] // 0 = current is left child, 1 = current is right child
  root: string          // 0x-prefixed current root
  leafIndex: number
}

const LEAF_INSERTED_TOPIC = ethers.id("LeafInserted(uint32,bytes32,bytes32)");

// Default span per eth_getLogs request. Public Polygon RPCs (e.g. publicnode) reject a
// single fromBlock:0→latest scan over millions of blocks, so we page. getLogsChunked also
// halves the span on a range/result-limit error, so this is just a starting size.
// Max blocks per getLogs request. MUST be ≤ the RPC's getLogs range limit (Alchemy FREE caps it at
// 10!; most other tiers allow ≥2000–10000). Set LOG_SCAN_CHUNK to match your RPC.
const DEFAULT_LOG_CHUNK = Number(process.env.LOG_SCAN_CHUNK ?? "10000");
// Gentle delay between successful getLogs requests to stay under a provider's per-second
// compute-unit cap (Alchemy free tier ~330 CUPS; eth_getLogs is dozens of CU each). Tunable.
const LOG_REQUEST_DELAY_MS = Number(process.env.MERKLE_LOG_DELAY_MS ?? "250");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A 429 / "compute units per second" / rate-limit error — retry the SAME range with backoff, never
 * halve (halving means MORE requests, which makes a rate limit worse). Distinct from a range/result
 * limit, which we recover from by halving. */
function isRateLimit(err: unknown): boolean {
  const e = err as { code?: unknown; error?: { code?: unknown; message?: unknown }; shortMessage?: unknown; message?: unknown };
  const code = e?.error?.code ?? e?.code;
  const msg = String(e?.error?.message ?? e?.shortMessage ?? e?.message ?? "").toLowerCase();
  return code === 429 || code === -32005 || msg.includes("compute unit") || msg.includes("rate limit") ||
    msg.includes("too many requests") || msg.includes("429") || msg.includes("throughput");
}

/**
 * JsonRpcProvider that retries rate-limit (429) errors on EVERY RPC method — including the
 * eth_sendRawTransaction / eth_getTransactionReceipt used when RELAYING user proofs (authorizeBet,
 * creditSettlement, partialFillCredit, withdraw). Without this, a metered RPC's 429 intermittently
 * fails the relay (and the user's claim/settle/withdraw). Range-too-large errors are NOT retried here
 * (the merkle scan pages via getLogsChunked instead).
 */
export class RetryingJsonRpcProvider extends ethers.JsonRpcProvider {
  // `staticNetwork: true` detects the chain ONCE and treats it as fixed, so ethers stops re-issuing
  // `eth_chainId` to re-validate the network around operations. The chain never changes under us.
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
          await sleep(Math.min(8_000, 300 * 2 ** attempt));
          continue;
        }
        throw err;
      }
    }
  }
}

// Shared, short-TTL cache of eth_blockNumber. The merkle cache and the event index each poll for the
// chain head on their own timer; before this they issued a separate getBlockNumber per loop per tick.
// Coalescing them behind one cached read (and one in-flight promise) removes the duplicate head calls —
// a few seconds of staleness only delays indexing slightly, and both loops already lag by CONFIRMATIONS.
let _headValue = 0;
let _headAt = 0;
let _headInFlight: Promise<number> | null = null;
const HEAD_TTL_MS = Number(process.env.BLOCK_HEAD_TTL_MS ?? "5000");

export async function getCachedBlockNumber(provider: ethers.JsonRpcProvider): Promise<number> {
  const now = Date.now();
  if (now - _headAt < HEAD_TTL_MS && _headValue > 0) return _headValue;
  if (_headInFlight) return _headInFlight;
  _headInFlight = provider
    .getBlockNumber()
    .then((bn) => {
      _headValue = bn;
      _headAt = Date.now();
      return bn;
    })
    .finally(() => {
      _headInFlight = null;
    });
  return _headInFlight;
}

/**
 * Fetch logs over [fromBlock, toBlock] in chunks, adapting to the RPC's limits:
 *  - rate-limit (429): back off exponentially and RETRY the same range (don't halve);
 *  - range/result-too-large: halve the span and retry;
 *  - single-block non-rate-limit failure: a genuine RPC error → give up.
 */
// Combined vault+tree log scan. When configured (production), the merkle cache AND the event index pull
// their logs from ONE getLogs over BOTH addresses — halving the getLogs each sync makes — then each
// filters its own. An in-flight-promise memo (keyed by block range) means the two caches' concurrent
// syncs share a single fetch. Not configured (e.g. a resync script) → returns null and callers fall
// back to their own per-address scan, so behaviour is unchanged there.
let _combinedAddrs: string[] | null = null;
export function setCombinedLogScan(vaultAddress: string, treeAddress: string): void {
  _combinedAddrs = [vaultAddress, treeAddress];
}

let _combinedInFlight: { key: string; at: number; p: Promise<ethers.Log[]> } | null = null;
const COMBINED_MEMO_MS = Number(process.env.COMBINED_LOGS_MEMO_MS ?? "5000");

export async function getVaultTreeLogs(
  provider: ethers.JsonRpcProvider,
  fromBlock: number,
  toBlock: number,
  startChunk: number,
): Promise<ethers.Log[] | null> {
  if (!_combinedAddrs) return null;
  const key = `${fromBlock}-${toBlock}`;
  const now = Date.now();
  if (_combinedInFlight && _combinedInFlight.key === key && now - _combinedInFlight.at < COMBINED_MEMO_MS) {
    return _combinedInFlight.p;
  }
  // No topic filter: pull all logs from both contracts in one call; each cache filters its own. (The
  // vault/tree don't emit a meaningful volume of unrelated events, so the extra payload is negligible.)
  const p = getLogsChunked(provider, { address: _combinedAddrs, topics: [] }, fromBlock, toBlock, startChunk);
  _combinedInFlight = { key, at: now, p };
  return p;
}

export async function getLogsChunked(
  provider: ethers.JsonRpcProvider,
  filter: { address: string | string[]; topics: (string | string[] | null)[] },
  fromBlock: number,
  toBlock: number,
  startChunk: number,
): Promise<ethers.Log[]> {
  const out: ethers.Log[] = [];
  let from = fromBlock;
  let chunk = Math.max(1, startChunk);
  while (from <= toBlock) {
    const to = Math.min(from + chunk - 1, toBlock);
    try {
      const logs = await provider.getLogs({ ...filter, fromBlock: from, toBlock: to });
      out.push(...logs);
      from = to + 1;
      if (from <= toBlock && LOG_REQUEST_DELAY_MS > 0) await sleep(LOG_REQUEST_DELAY_MS);
    } catch (err) {
      // 429s are ALREADY retried inside RetryingJsonRpcProvider — do NOT also retry here. Nested
      // retries (8× in the provider × N× here) compound into a multi-minute hang. Propagate a
      // rate-limit so the caller (cache sync next tick / API fallback) handles it; only SHRINK the
      // span for a genuine range/result-too-large error.
      if (isRateLimit(err)) throw err;
      if (to === from) throw err; // single-block non-rate-limit failure → genuine error
      chunk = Math.max(1, Math.floor(chunk / 2));
    }
  }
  return out;
}

export async function computeMerkleProof(
  treeAddress: string,
  commitment: string,
  provider: ethers.JsonRpcProvider,
  opts?: { fromBlock?: number; chunkSize?: number },
): Promise<MerkleProof | null> {
  // 1. Fetch all LeafInserted events. Start from the tree's deploy block (opts.fromBlock) so
  //    we don't scan the entire chain history, and page to stay under RPC getLogs limits.
  const latest = await provider.getBlockNumber();
  const fromBlock = Math.max(0, Math.min(opts?.fromBlock ?? 0, latest));
  const logs = await getLogsChunked(
    provider,
    { address: treeAddress, topics: [LEAF_INSERTED_TOPIC] },
    fromBlock,
    latest,
    opts?.chunkSize ?? DEFAULT_LOG_CHUNK,
  );

  // Parse leaves in insertion order
  const leaves: bigint[] = [];
  for (const log of logs) {
    // LeafInserted(uint32 indexed leafIndex, bytes32 leaf, bytes32 newRoot)
    const iface = new ethers.Interface([
      "event LeafInserted(uint32 indexed leafIndex, bytes32 leaf, bytes32 newRoot)",
    ]);
    const parsed = iface.parseLog(log);
    if (!parsed) continue;
    const leafIndex = Number(parsed.args[0]);
    const leaf = BigInt(parsed.args[1] as string);
    leaves[leafIndex] = leaf;
  }

  const target = BigInt(commitment);
  const targetIdx = leaves.findIndex((l) => l === target);
  if (targetIdx === -1) return null;

  // 2. Build the proof by walking up the tree layer by layer
  const n = leaves.length;
  const path: bigint[] = [];
  const pathIndices: number[] = [];

  let layer: bigint[] = [...leaves];
  let idx = targetIdx;

  for (let level = 0; level < TREE_DEPTH; level++) {
    const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;

    // Sibling value: use actual leaf/node if it exists, else the zero subtree hash
    const sibling = siblingIdx < layer.length ? layer[siblingIdx] : ZEROS[level];
    path.push(sibling);
    pathIndices.push(idx % 2); // 0 = we're left child, 1 = we're right child

    // Build the next layer up
    const nextLayer: bigint[] = [];
    for (let j = 0; j < Math.max(layer.length, 1); j += 2) {
      const left = j < layer.length ? layer[j] : ZEROS[level];
      const right = j + 1 < layer.length ? layer[j + 1] : ZEROS[level];
      nextLayer.push(poseidon2([left, right]));
    }

    layer = nextLayer;
    idx = Math.floor(idx / 2);
  }

  // Root is what remains after all 32 levels
  const root = layer[0] ?? ZEROS[TREE_DEPTH];

  return {
    path: path.map(toHex),
    pathIndices,
    root: toHex(root),
    leafIndex: targetIdx,
  };
}
