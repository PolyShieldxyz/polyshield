import { ethers } from "ethers";
import pino from "pino";
import { config } from "./config";
import { startHeartbeat, stopHeartbeat } from "./heartbeat";
import { startEventListener } from "./eventListener";
import { startSettlementResolver } from "./settlementResolver";
import { startAutoSettlementServer } from "./autoSettlement";
import { signingLayerNonceManager } from "./nonceManager";
import { sendHeartbeat } from "./orderBuilder";
import { getDepositWalletExecutor } from "./depositWalletExecutor";
import { setAttestationDomainParams } from "./attestationStore";
import { startFillTracker, stopFillTracker } from "./wsFillTracker";

const logger = pino({ name: "signing-layer" });

// EOA private key comes from env only — never logged, never sent anywhere except Polygon RPC
const provider = new ethers.JsonRpcProvider(config.polygonRpcUrl);
const wallet = new ethers.Wallet(config.vaultEoaPrivateKey, provider);

logger.info({ address: wallet.address }, "Signing layer started");
signingLayerNonceManager.reset();
void signingLayerNonceManager.checkForChainReset(provider);

/**
 * One-time setup (H3): ensure the deposit wallet has approved pUSD to the CTF
 * exchange and the offramp. Routed through the DepositWalletExecutor so the same
 * path runs against the mock relayer locally and the Polymarket relayer in
 * production. Best-effort — a hiccup here must not crash the signing layer.
 */
async function ensureDepositWalletApprovals(): Promise<void> {
  try {
    const executor = getDepositWalletExecutor(provider);
    await executor.ensureApprovals();
    logger.info({ executor: executor.kind }, "deposit-wallet approvals ensured (H3)");
  } catch (err) {
    logger.warn({ err, depositWallet: config.depositWalletAddress }, "ensureDepositWalletApprovals failed (non-fatal)");
  }
}

// Heartbeat: maintains the Polymarket CLOB session alive.
// API-010: real best-effort heartbeat. sendHeartbeat pings the CLOB (mock or
// production) and routes the response through circuitBreaker.checkResponse, so a
// 403 / ACCOUNT_FLAGGED halts all signing. It is internally defensive — it never
// throws — but we also guard here so a heartbeat hiccup can't crash the layer.
startHeartbeat(async () => {
  try {
    return await sendHeartbeat(wallet);
  } catch (err) {
    logger.warn({ err }, "heartbeat invocation failed — continuing");
    return "";
  }
});

/**
 * FC-9: resolve the EIP-712 domain params (chainId from the chain, verifyingContract
 * from config) BEFORE starting the event listener, since the listener signs operator
 * attestations in place of the old on-chain report* txs. Also sanity-check that the
 * signing wallet IS the operator the Vault expects to recover, since the on-chain
 * attestation verification requires signer == signingLayerOperator.
 */
async function bootstrap(): Promise<void> {
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  setAttestationDomainParams({ chainId, verifyingContract: config.vaultContractAddress });
  logger.info({ chainId, verifyingContract: config.vaultContractAddress }, "attestation EIP-712 domain initialized");

  if (
    config.signingLayerOperatorAddress &&
    wallet.address.toLowerCase() !== config.signingLayerOperatorAddress.toLowerCase()
  ) {
    // Not fatal locally (e.g. misconfigured env), but every signed attestation would
    // be rejected on-chain. Surface loudly.
    logger.error(
      { walletAddress: wallet.address, expectedOperator: config.signingLayerOperatorAddress },
      "signing wallet != signingLayerOperator — operator attestations will be REJECTED on-chain",
    );
  }

  void ensureDepositWalletApprovals();
  startEventListener(provider, wallet);
  // FC-4: connect the user-channel websocket fill tracker and resume any resting orders
  // that were still open (and un-attested) before this process started. Must be up
  // before/while the event listener submits resting GTC/GTD orders so trackOrder() has
  // a live connection to register against.
  startFillTracker(wallet);
  startSettlementResolver(provider, wallet);
  startAutoSettlementServer(provider, wallet);
}

void bootstrap().catch((err) => {
  logger.error({ err }, "signing-layer bootstrap failed");
  process.exit(1);
});

process.on("SIGTERM", () => {
  logger.info("SIGTERM received — shutting down");
  stopHeartbeat();
  stopFillTracker();
  process.exit(0);
});

process.on("SIGINT", () => {
  logger.info("SIGINT received — shutting down");
  stopHeartbeat();
  stopFillTracker();
  process.exit(0);
});
