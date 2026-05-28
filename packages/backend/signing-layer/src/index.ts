import { ethers } from "ethers";
import pino from "pino";
import { config } from "./config";
import { startHeartbeat, stopHeartbeat } from "./heartbeat";
import { startEventListener } from "./eventListener";
import { startSettlementResolver } from "./settlementResolver";
import { startAutoSettlementServer } from "./autoSettlement";
import { signingLayerNonceManager } from "./nonceManager";

const logger = pino({ name: "signing-layer" });

// EOA private key comes from env only — never logged, never sent anywhere except Polygon RPC
const provider = new ethers.JsonRpcProvider(config.polygonRpcUrl);
const wallet = new ethers.Wallet(config.vaultEoaPrivateKey, provider);

logger.info({ address: wallet.address }, "Signing layer started");
signingLayerNonceManager.reset();
void signingLayerNonceManager.checkForChainReset(provider);

/**
 * One-time setup: ensure the deposit wallet has approved pUSD to CTF Exchange V2.
 * In local mock mode this is a no-op (MockCTF.mintShares doesn't require approvals).
 * In production this must be submitted as a Polymarket relayer WALLET batch before
 * any order can fill. Currently logs a reminder; wire @polymarket/builder-relayer-client
 * here when integrating the production relayer path (see BUG-H3 in collateral-flow-audit.md).
 */
async function ensureDepositWalletApprovals(): Promise<void> {
  const isMock =
    config.polygonRpcUrl.includes("localhost") || config.polygonRpcUrl.includes("127.0.0.1");
  if (isMock) {
    logger.info("Mock mode: skipping deposit wallet approval setup");
    return;
  }
  // TODO (H3): submit WALLET batch via Polymarket relayer to approve pUSD → CTF Exchange V2
  // and call clobClient.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL }).
  // Until the relayer client is wired, operators must perform this one-time approval
  // manually before the first order.
  logger.warn(
    { depositWallet: config.depositWalletAddress },
    "H3: deposit wallet pUSD approval not yet automated — ensure it has been set via relayer WALLET batch before first order"
  );
}

// Heartbeat: maintains Polymarket CLOB session alive
// The clob-client is initialized lazily in orderBuilder.ts on first order
startHeartbeat(async () => {
  // Heartbeat is a no-op until the clob client is wired in the full integration.
  // In production: call client.postHeartbeat() and return the heartbeat_id.
  return "";
});

void ensureDepositWalletApprovals();
startEventListener(provider, wallet);
startSettlementResolver(provider, wallet);
startAutoSettlementServer(provider, wallet);

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
