import "dotenv/config";
import { ethers } from "ethers";
import pino from "pino";
import { initRelayer } from "./relayer";
import { createApp, initMerkle } from "./api";

const logger = pino({
  name: "proof-relay",
  // Never log source IP addresses of proof submitters
  redact: ["req.headers[\"x-forwarded-for\"]", "req.socket.remoteAddress", "req.ip"],
});

const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY;
const VAULT_CONTRACT_ADDRESS = process.env.VAULT_CONTRACT_ADDRESS;
const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL;
const TREE_ADDRESS = process.env.TREE_ADDRESS;
const PORT = parseInt(process.env.PROOF_RELAY_PORT ?? "3002", 10);

if (!RELAYER_PRIVATE_KEY || !VAULT_CONTRACT_ADDRESS || !POLYGON_RPC_URL) {
  logger.error("RELAYER_PRIVATE_KEY, VAULT_CONTRACT_ADDRESS, and POLYGON_RPC_URL are required");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(POLYGON_RPC_URL);
initRelayer(RELAYER_PRIVATE_KEY, VAULT_CONTRACT_ADDRESS, provider);

if (TREE_ADDRESS) {
  initMerkle(provider, TREE_ADDRESS, VAULT_CONTRACT_ADDRESS);
  logger.info({ treeAddress: TREE_ADDRESS }, "merkle path endpoint enabled");
} else {
  logger.warn("TREE_ADDRESS not set — /merkle-path endpoint disabled");
}

const app = createApp();
app.listen(PORT, () => {
  logger.info({ port: PORT }, "Proof Relay listening");
});
