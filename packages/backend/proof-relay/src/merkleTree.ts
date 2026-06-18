/**
 * Backend read-cache of the on-chain CommitmentMerkleTree.
 *
 * The ON-CHAIN tree remains authoritative — it is the source of truth, publicly queryable, and what
 * every ZK proof is verified against. This is ONLY a local mirror so that serving a Merkle path costs
 * an O(depth) in-memory lookup instead of re-scanning the entire LeafInserted history from the chain
 * on every request (which is slow and hammers a metered RPC at scale).
 *
 * Maintained incrementally and append-only: each new LeafInserted event updates the O(depth)=32 nodes
 * on the new leaf's path. CORRECTNESS GUARANTEE: the LeafInserted(leafIndex, leaf, newRoot) event
 * carries the chain's root AFTER that insert, so for EVERY leaf we append we recompute our root and
 * assert it equals the on-chain `newRoot`. A mismatch marks the cache inconsistent and the API falls
 * back to authoritative on-the-fly computation. A periodic `currentRoot()` state-read cross-check is a
 * second safety net.
 *
 * Persisted to SQLite (PROOF_RELAY_DB_PATH) so a restart resumes from the last block instead of
 * re-scanning from the deploy block. With no DB path / a DB failure it runs in-memory and rebuilds
 * from chain on each start — same correctness, just a slower cold start.
 */

import Database from "better-sqlite3";
import { ethers } from "ethers";
import { poseidon2 } from "poseidon-lite";
import pino from "pino";
import { getLogsChunked, getCachedBlockNumber, getVaultTreeLogs } from "./merkle";

const logger = pino({ name: "merkle-cache" });

const TREE_DEPTH = 32;
const LEAF_INSERTED_TOPIC = ethers.id("LeafInserted(uint32,bytes32,bytes32)");
const LEAF_INSERTED_ABI = new ethers.Interface([
  "event LeafInserted(uint32 indexed leafIndex, bytes32 leaf, bytes32 newRoot)",
]);
// Steady-state cadence is a SLOW safety reconcile (C1): the relay calls syncNow() right after it
// confirms a leaf-inserting tx, and /merkle-path also syncs on a cache miss. This timer mainly exists
// to catch user deposit() txs (not relayed by us) and as a divergence backstop.
const POLL_MS = Number(process.env.MERKLE_CACHE_RECONCILE_MS ?? "600000");
// Small confirmation buffer so a shallow Polygon reorg can't poison the cache. Leaves newer than this
// are served by the on-the-fly fallback until they confirm.
const CONFIRMATIONS = Number(process.env.MERKLE_CACHE_CONFIRMATIONS ?? "3");
// Max blocks per getLogs request. MUST be ≤ the RPC's getLogs range limit (Alchemy FREE = 10!,
// most paid/other tiers ≥ 2000–10000). Set LOG_SCAN_CHUNK=10 for Alchemy free.
const LOG_CHUNK = Number(process.env.LOG_SCAN_CHUNK ?? "10000");
// Blocks per scan WINDOW. After each window the cursor is persisted, so an interrupted long scan
// (e.g. the one-time historical seed) resumes from the last window instead of restarting from deploy.
const SCAN_WINDOW = Number(process.env.MERKLE_SCAN_WINDOW ?? "5000");

// Zero subtree hashes — MUST match merkle.ts / the on-chain tree (zeros[0]=0, zeros[i+1]=H(zi,zi)).
function buildZeros(): bigint[] {
  const z: bigint[] = [0n];
  for (let i = 0; i < TREE_DEPTH; i++) z.push(poseidon2([z[i], z[i]]));
  return z;
}
const ZEROS = buildZeros();
const toHex = (n: bigint): string => "0x" + n.toString(16).padStart(64, "0");

export interface MerkleProof {
  path: string[];
  pathIndices: number[];
  root: string;
  leafIndex: number;
}

export class CachedMerkleTree {
  private db: Database.Database | null = null;
  private nodes = new Map<string, bigint>(); // `${level}:${index}` -> hash
  private indexByLeaf = new Map<bigint, number>(); // leaf commitment -> insertion index
  private nextIndex = 0;
  private lastBlock: number;
  private ready = false;
  private consistent = true;
  private syncInFlight: Promise<void> | null = null;

  constructor(
    private provider: ethers.JsonRpcProvider,
    private treeAddress: string,
    private deployBlock: number,
    dbPath: string | null,
  ) {
    this.lastBlock = Math.max(0, deployBlock - 1);
    if (dbPath) {
      try {
        this.db = new Database(dbPath);
        this.db.pragma("journal_mode = WAL");
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS merkle_leaves (idx INTEGER PRIMARY KEY, leaf TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS merkle_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
        `);
      } catch (err) {
        logger.error({ err: String(err) }, "merkle cache DB init failed — running in-memory (rebuild from chain each start)");
        this.db = null;
      }
    }
  }

  /** The cache may serve a path only when it has fully synced AND every leaf matched the chain root. */
  isReady(): boolean {
    return this.ready && this.consistent;
  }

  private nkey(level: number, index: number): string {
    return `${level}:${index}`;
  }
  private getNode(level: number, index: number): bigint {
    return this.nodes.get(this.nkey(level, index)) ?? ZEROS[level];
  }

  /** Append a leaf at the next index; update the 32 nodes on its path; return the new computed root. */
  private append(leaf: bigint): bigint {
    const idx = this.nextIndex;
    this.nodes.set(this.nkey(0, idx), leaf);
    this.indexByLeaf.set(leaf, idx);
    let i = idx;
    for (let level = 0; level < TREE_DEPTH; level++) {
      const parent = i >> 1;
      const left = this.getNode(level, parent * 2);
      const right = this.getNode(level, parent * 2 + 1);
      this.nodes.set(this.nkey(level + 1, parent), poseidon2([left, right]));
      i = parent;
    }
    this.nextIndex = idx + 1;
    return this.getNode(TREE_DEPTH, 0);
  }

  private root(): bigint {
    return this.getNode(TREE_DEPTH, 0);
  }

  private proofForIndex(idx: number): MerkleProof {
    const path: string[] = [];
    const pathIndices: number[] = [];
    let i = idx;
    for (let level = 0; level < TREE_DEPTH; level++) {
      path.push(toHex(this.getNode(level, i ^ 1)));
      pathIndices.push(i & 1);
      i = i >> 1;
    }
    return { path, pathIndices, root: toHex(this.root()), leafIndex: idx };
  }

  /** Serve a Merkle proof from the cache, or null if not ready / leaf not (yet) ingested. */
  proofFor(commitment: string): MerkleProof | null {
    if (!this.isReady()) return null;
    const idx = this.indexByLeaf.get(BigInt(commitment));
    return idx === undefined ? null : this.proofForIndex(idx);
  }

  private resetInMemory(): void {
    this.nodes.clear();
    this.indexByLeaf.clear();
    this.nextIndex = 0;
    this.lastBlock = Math.max(0, this.deployBlock - 1);
    if (this.db) this.db.exec("DELETE FROM merkle_leaves; DELETE FROM merkle_meta;");
  }

  private loadFromDb(): void {
    if (!this.db) return;
    const rows = this.db
      .prepare("SELECT idx, leaf FROM merkle_leaves ORDER BY idx ASC")
      .all() as Array<{ idx: number; leaf: string }>;
    for (const r of rows) {
      if (r.idx !== this.nextIndex) {
        logger.error({ expected: this.nextIndex, got: r.idx }, "persisted leaf gap — discarding cache, rebuilding from chain");
        this.resetInMemory();
        return;
      }
      this.append(BigInt(r.leaf));
    }
    const meta = this.db.prepare("SELECT v FROM merkle_meta WHERE k = 'last_block'").get() as { v: string } | undefined;
    if (meta && this.nextIndex > 0) this.lastBlock = parseInt(meta.v, 10);
    logger.info({ leaves: this.nextIndex, lastBlock: this.lastBlock }, "merkle cache loaded from DB");
  }

  private persistLeaf(idx: number, leaf: bigint): void {
    this.db?.prepare("INSERT OR REPLACE INTO merkle_leaves (idx, leaf) VALUES (?, ?)").run(idx, toHex(leaf));
  }
  private persistLastBlock(): void {
    this.db?.prepare("INSERT OR REPLACE INTO merkle_meta (k, v) VALUES ('last_block', ?)").run(String(this.lastBlock));
  }

  /** Pull new LeafInserted events and append them, verifying each computed root == the chain's newRoot.
   * Scans in WINDOWs and persists the cursor after each, so an interrupted long scan (the one-time
   * historical seed on a tiny-getLogs-limit RPC) RESUMES from the last window instead of restarting. */
  private async sync(): Promise<void> {
    if (!this.consistent) return; // already diverged — API is using the on-chain fallback
    const head = await getCachedBlockNumber(this.provider);
    const target = head - CONFIRMATIONS;
    if (target <= this.lastBlock) return;

    let cursor = this.lastBlock + 1;
    while (cursor <= target && this.consistent) {
      const windowEnd = Math.min(cursor + SCAN_WINDOW - 1, target);
      // Prefer the shared vault+tree scan (one getLogs for both caches), then keep only this tree's
      // LeafInserted logs. Falls back to a tree-only scan when the combined scan isn't configured.
      const combined = await getVaultTreeLogs(this.provider, cursor, windowEnd, LOG_CHUNK);
      const logs = combined !== null
        ? combined.filter((l) => l.address.toLowerCase() === this.treeAddress.toLowerCase() && l.topics[0] === LEAF_INSERTED_TOPIC)
        : await getLogsChunked(
            this.provider,
            { address: this.treeAddress, topics: [LEAF_INSERTED_TOPIC] },
            cursor,
            windowEnd,
            LOG_CHUNK,
          );
      const events = logs
        .map((l) => {
          const p = LEAF_INSERTED_ABI.parseLog(l);
          return p ? { leafIndex: Number(p.args[0]), leaf: BigInt(p.args[1] as string), newRoot: BigInt(p.args[2] as string) } : null;
        })
        .filter((e): e is NonNullable<typeof e> => e !== null)
        .sort((a, b) => a.leafIndex - b.leafIndex);

      for (const ev of events) {
        if (ev.leafIndex < this.nextIndex) continue; // already have it (range overlap)
        if (ev.leafIndex !== this.nextIndex) {
          logger.error({ expected: this.nextIndex, got: ev.leafIndex }, "leaf index gap — rebuilding cache from deploy block");
          this.resetInMemory();
          return; // next tick re-scans from the (reset) deploy block
        }
        const computedRoot = this.append(ev.leaf);
        if (computedRoot !== ev.newRoot) {
          this.consistent = false;
          logger.error(
            { leafIndex: ev.leafIndex, computed: toHex(computedRoot), onChain: toHex(ev.newRoot) },
            "ROOT MISMATCH — backend tree diverged from chain; API now falls back to on-chain computation",
          );
          return;
        }
        logger.info(
          { leafIndex: ev.leafIndex, leaf: toHex(ev.leaf), root: toHex(computedRoot) },
          "merkle cache: leaf added (computed root == on-chain newRoot ✓)",
        );
        this.persistLeaf(ev.leafIndex, ev.leaf);
      }
      // Persist progress per WINDOW. If a later window throws (rate-limit propagated), the cursor is
      // already saved up to here, so the next tick / a restart resumes instead of re-scanning.
      this.lastBlock = windowEnd;
      this.persistLastBlock();
      if (this.nextIndex > 0 && windowEnd < target) {
        logger.info({ leaves: this.nextIndex, scannedTo: windowEnd, target }, "merkle cache: scan progress");
      }
      cursor = windowEnd + 1;
    }
  }

  /** Serialize sync() so the background poll and an on-demand syncNow() never overlap (a concurrent
   *  run would race lastBlock/nextIndex and risk double-appending). Callers share the in-flight run. */
  private runSync(): Promise<void> {
    if (this.syncInFlight) return this.syncInFlight;
    this.syncInFlight = this.sync().finally(() => {
      this.syncInFlight = null;
    });
    return this.syncInFlight;
  }

  /** Trigger an immediate incremental catch-up (only new blocks since the cursor — cheap). Used by the
   *  /merkle-path route on a cache miss so a freshly-inserted leaf is picked up in seconds without the
   *  slow full from-deploy fallback. No-op if the cache has diverged (the API uses the on-chain path). */
  async syncNow(): Promise<void> {
    if (!this.consistent) return;
    await this.runSync().catch((err) => logger.error({ err: String(err) }, "merkle cache syncNow failed"));
  }

  /** Belt-and-suspenders: the cached root must equal the contract's live currentRoot once caught up. */
  private async verifyAgainstChain(): Promise<void> {
    if (!this.isReady() || this.nextIndex === 0) return;
    try {
      const tree = new ethers.Contract(this.treeAddress, ["function currentRoot() view returns (bytes32)"], this.provider);
      const onChain = BigInt(await tree.currentRoot());
      if (this.root() !== onChain) {
        // Usually benign confirmation lag (a leaf inside the CONFIRMATIONS window not yet ingested).
        logger.warn({ cached: toHex(this.root()), onChain: toHex(onChain), leaves: this.nextIndex }, "cache root != on-chain currentRoot (likely confirmation lag)");
      }
    } catch (err) {
      logger.warn({ err: String(err) }, "currentRoot cross-check failed");
    }
  }

  /** One-shot backfill: load persisted leaves + catch up to head, WITHOUT starting the background
   *  poll intervals. For the resync CLI. Returns the resulting state (leaves, cursor, consistency,
   *  computed root). If `consistent` is false the on-chain tree diverged from the persisted leaves —
   *  the DB must be rebuilt from scratch (delete merkle.db and re-run). */
  async catchUp(): Promise<{ leaves: number; lastBlock: number; consistent: boolean; root: string }> {
    this.loadFromDb();
    await this.runSync();
    this.ready = true;
    return { leaves: this.nextIndex, lastBlock: this.lastBlock, consistent: this.consistent, root: toHex(this.root()) };
  }

  async start(): Promise<void> {
    this.loadFromDb();
    logger.info({ fromBlock: this.lastBlock + 1, haveLeaves: this.nextIndex }, "merkle cache: starting catch-up scan (one-time full scan on a fresh cache)");
    await this.runSync();
    this.ready = true;
    logger.info({ leaves: this.nextIndex, consistent: this.consistent, persisted: !!this.db }, "merkle cache ready");
    setInterval(() => void this.runSync().catch((err) => logger.error({ err: String(err) }, "merkle cache sync failed")), POLL_MS);
    setInterval(() => void this.verifyAgainstChain(), POLL_MS * 4);
  }
}
