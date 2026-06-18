import "dotenv/config";
import { ethers } from "ethers";
import pino from "pino";
import { initRelayer, setOnRelayConfirmed } from "./relayer";
import { createApp, initMerkle, setMerkleCache, setEventIndex } from "./api";
import { RetryingJsonRpcProvider, setCombinedLogScan } from "./merkle";
import { CachedMerkleTree } from "./merkleTree";
import { VaultEventIndex } from "./eventIndex";
import { startMarketCatalogSync } from "./marketCatalog";
import { startVaultLogSubscriber } from "./vaultLogSubscriber";

const logger = pino({
  name: "proof-relay",
  // Never log source IP addresses of proof submitters
  redact: ["req.headers[\"x-forwarded-for\"]", "req.socket.remoteAddress", "req.ip"],
});

const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY;
const VAULT_CONTRACT_ADDRESS = process.env.VAULT_CONTRACT_ADDRESS;
const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL;
// B1 (optional): a WS RPC endpoint for `eth_subscribe("logs")`. When set, vault/tree log events push
// an immediate cache sync instead of waiting for the slow HTTP reconcile. Used as a LATENCY accelerator
// only — the HTTP reconcile stays authoritative, so a free-tier / flaky WS is safe. Unset = HTTP only.
const POLYGON_WS_URL = process.env.POLYGON_WS_URL;
const TREE_ADDRESS = process.env.TREE_ADDRESS;
// Block the CommitmentMerkleTree was deployed at. The /merkle-path scan starts here instead
// of block 0 so public Polygon RPCs don't reject the getLogs range. 0 = scan from genesis.
const TREE_DEPLOY_BLOCK = parseInt(process.env.TREE_DEPLOY_BLOCK ?? "0", 10);
const PORT = parseInt(process.env.PROOF_RELAY_PORT ?? "3002", 10);

if (!RELAYER_PRIVATE_KEY || !VAULT_CONTRACT_ADDRESS || !POLYGON_RPC_URL) {
  logger.error("RELAYER_PRIVATE_KEY, VAULT_CONTRACT_ADDRESS, and POLYGON_RPC_URL are required");
  process.exit(1);
}

// Retries 429s on every RPC call (relay tx send/receipt + merkle getLogs) so a metered RPC can't
// intermittently fail a user's claim/settle/withdraw relay.
const provider = new RetryingJsonRpcProvider(POLYGON_RPC_URL);
initRelayer(RELAYER_PRIVATE_KEY, VAULT_CONTRACT_ADDRESS, provider);

if (TREE_ADDRESS) {
  // The merkle cache (tree LeafInserted) and event index (vault events) now share ONE getLogs over
  // both addresses per sync instead of one each. See getVaultTreeLogs.
  setCombinedLogScan(VAULT_CONTRACT_ADDRESS, TREE_ADDRESS);
  initMerkle(provider, TREE_ADDRESS, VAULT_CONTRACT_ADDRESS, TREE_DEPLOY_BLOCK);
  // Backend read-cache of the on-chain tree: serves /merkle-path in O(depth) with no per-request
  // chain scan. The on-chain tree stays authoritative; the cache verifies every appended leaf's root
  // against the chain's LeafInserted.newRoot and falls back to on-the-fly computation if it diverges.
  const merkleCache = new CachedMerkleTree(provider, TREE_ADDRESS, TREE_DEPLOY_BLOCK, process.env.PROOF_RELAY_DB_PATH ?? null);
  setMerkleCache(merkleCache);
  merkleCache.start().catch((err) => logger.error({ err: String(err) }, "merkle cache start failed — serving on-the-fly only"));
  logger.info({ treeAddress: TREE_ADDRESS, treeDeployBlock: TREE_DEPLOY_BLOCK, dbPath: process.env.PROOF_RELAY_DB_PATH ?? "(in-memory)" }, "merkle path endpoint enabled (with backend cache)");

  // Vault event index → /recovery-data, so the frontend recovers notes from us (not its own RPC).
  const eventIndex = new VaultEventIndex(provider, VAULT_CONTRACT_ADDRESS, TREE_DEPLOY_BLOCK, process.env.PROOF_RELAY_DB_PATH ?? null);
  setEventIndex(eventIndex);
  eventIndex.start().catch((err) => logger.error({ err: String(err) }, "event index start failed — /recovery-data disabled"));

  // Shared nudge: pull new on-chain state into both caches now (cheap incremental, cursor-based getLogs).
  const nudgeCaches = () => {
    void merkleCache.syncNow();
    void eventIndex.syncNow();
  };

  // C1 (sync-on-relay): the moment a relayed tx confirms, pull the new leaf/event into both caches
  // immediately — so the steady-state poll can stay slow (it only needs to catch user deposit() txs).
  setOnRelayConfirmed(nudgeCaches);

  // B1 (WS accelerator, optional): push-drive the same nudge on any vault/tree log, so events land in
  // ~a block instead of waiting for the reconcile. Accelerator only — nudgeCaches is the authoritative
  // (root-verified, cursor-based) sync, so a dropped/lossy WS costs latency, never correctness.
  if (POLYGON_WS_URL) {
    startVaultLogSubscriber({
      wsUrl: POLYGON_WS_URL,
      addresses: [VAULT_CONTRACT_ADDRESS, TREE_ADDRESS],
      onActivity: nudgeCaches,
    });
    logger.info({ ws: true }, "vault log WS subscriber enabled (latency accelerator; HTTP reconcile remains authoritative)");
  } else {
    logger.info({ ws: false }, "POLYGON_WS_URL unset — using HTTP reconcile + sync-on-relay only (no WS)");
  }
} else {
  logger.warn("TREE_ADDRESS not set — /merkle-path endpoint disabled");
}

// FC-15: mirror the active Polymarket market universe into the local catalog (~10 min loop) so the
// markets page browses a large, bettable-only, cached set served by /markets. Public data only.
startMarketCatalogSync();

const app = createApp();
// API-002/API-005: bind to loopback by default; override only via BIND_HOST.
app.listen(PORT, process.env.BIND_HOST || "127.0.0.1", () => {
  logger.info({ port: PORT }, "Proof Relay listening");
});
