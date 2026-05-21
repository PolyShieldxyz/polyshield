import { ethers } from "ethers";
import pino from "pino";
import { config } from "./config";
import { startHeartbeat, stopHeartbeat } from "./heartbeat";
import { startEventListener } from "./eventListener";

const logger = pino({ name: "signing-layer" });

// EOA private key comes from env only — never logged, never sent anywhere except Polygon RPC
const provider = new ethers.JsonRpcProvider(config.polygonRpcUrl);
const wallet = new ethers.Wallet(config.vaultEoaPrivateKey, provider);

logger.info({ address: wallet.address }, "Signing layer started");

// Heartbeat: maintains Polymarket CLOB session alive
// The clob-client is initialized lazily in orderBuilder.ts on first order
startHeartbeat(async () => {
  // Heartbeat is a no-op until the clob client is wired in the full integration.
  // In production: call client.postHeartbeat() and return the heartbeat_id.
  return "";
});

startEventListener(provider, wallet);

process.on("SIGTERM", () => {
  logger.info("SIGTERM received — shutting down");
  stopHeartbeat();
  process.exit(0);
});

process.on("SIGINT", () => {
  logger.info("SIGINT received — shutting down");
  stopHeartbeat();
  process.exit(0);
});
