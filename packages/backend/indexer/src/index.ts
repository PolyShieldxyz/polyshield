import "dotenv/config";
import { ethers } from "ethers";
import pino from "pino";
import { openDatabase } from "./database";
import { startCTFListener } from "./ctfListener";
import { startVaultListener } from "./vaultListener";
import { createApp, startServer } from "./api";

const logger = pino({ name: "indexer" });

const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL;
const VAULT_CONTRACT_ADDRESS = process.env.VAULT_CONTRACT_ADDRESS;
const INDEXER_DB_PATH = process.env.INDEXER_DB_PATH ?? "./indexer.db";
const PORT = parseInt(process.env.INDEXER_PORT ?? "3001", 10);

if (!POLYGON_RPC_URL) {
  logger.error("POLYGON_RPC_URL is required");
  process.exit(1);
}

openDatabase(INDEXER_DB_PATH);

const provider = new ethers.JsonRpcProvider(POLYGON_RPC_URL);

startCTFListener(provider).catch((err) => {
  logger.error({ err }, "CTF listener failed to start");
  process.exit(1);
});

if (VAULT_CONTRACT_ADDRESS) {
  startVaultListener(provider, VAULT_CONTRACT_ADDRESS);
} else {
  logger.warn("VAULT_CONTRACT_ADDRESS not set — MarketResolved timestamps will not be indexed");
}

const app = createApp();
startServer(app, PORT);
