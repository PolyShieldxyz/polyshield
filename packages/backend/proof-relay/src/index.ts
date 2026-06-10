import "dotenv/config";
import { ethers } from "ethers";
import pino from "pino";
import { initRelayer } from "./relayer";
import { createApp, initMerkle, setMerkleCache, setEventIndex } from "./api";
import { RetryingJsonRpcProvider } from "./merkle";
import { CachedMerkleTree } from "./merkleTree";
import { VaultEventIndex } from "./eventIndex";

const logger = pino({
  name: "proof-relay",
  // Never log source IP addresses of proof submitters
  redact: ["req.headers[\"x-forwarded-for\"]", "req.socket.remoteAddress", "req.ip"],
});

const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY;
const VAULT_CONTRACT_ADDRESS = process.env.VAULT_CONTRACT_ADDRESS;
const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL;
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
} else {
  logger.warn("TREE_ADDRESS not set — /merkle-path endpoint disabled");
}

const app = createApp();
// API-002/API-005: bind to loopback by default; override only via BIND_HOST.
app.listen(PORT, process.env.BIND_HOST || "127.0.0.1", () => {
  logger.info({ port: PORT }, "Proof Relay listening");
});
