import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import pino from "pino";
import { config } from "./config";
import { startHeartbeat, stopHeartbeat } from "./heartbeat";
import { startEventListener } from "./eventListener";
import { startSettlementResolver } from "./settlementResolver";
import { startAutoSettlementServer } from "./autoSettlement";
import { signingLayerNonceManager } from "./nonceManager";
import { sendHeartbeat } from "./orderBuilder";
import { getDepositWalletExecutor, deriveDepositWalletAddress } from "./depositWalletExecutor";
import { setAttestationDomainParams } from "./attestationStore";
import { startFillTracker, stopFillTracker } from "./wsFillTracker";
import { startMarketRegistrySync } from "./marketRegistry";
import { startBufferManager, stopBufferManager } from "./bufferManager";
import { RetryingJsonRpcProvider } from "./logScan";

const logger = pino({ name: "signing-layer" });

// Last-resort crash guard. A metered RPC (Alchemy) returns 429s under load; an uncaught 429 in any
// async chain used to kill the whole process (and `restart: on-failure:2` then left it DOWN). Log and
// keep running instead. The deliberate dead-man circuit breaker still halts via its own process.exit.
process.on("unhandledRejection", (reason) => {
  logger.error({ reason: reason instanceof Error ? reason.message : String(reason) }, "unhandledRejection — logged, NOT crashing (likely a transient RPC error)");
});
process.on("uncaughtException", (err) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, "uncaughtException — logged, NOT crashing");
});

// EOA private key comes from env only — never logged, never sent anywhere except Polygon RPC.
// RetryingJsonRpcProvider transparently retries 429 rate-limits on every RPC method (tx send, receipt
// wait, eth_call, getLogs) so a metered RPC can't crash signing or abort a settlement mid-flight.
const provider = new RetryingJsonRpcProvider(config.polygonRpcUrl);
const wallet = new ethers.Wallet(config.vaultEoaPrivateKey, provider);

logger.info({ address: wallet.address }, "Signing layer started");

/**
 * DEV: clear per-chain-instance state on startup when running against the mock CLOB.
 * `pnpm dev:mock` resets Anvil to a fresh chain every restart, but settlement.db
 * (attestations, tracked_orders, close/claim requests, limit-order intents) and the
 * event-listener cursor persist on disk — stale rows then reference dead nullifiers and
 * pollute the new chain. Wiping here mirrors the frontend's chain-reset wipe. It also
 * lets schema changes (e.g. the composite attestations PK) take effect without a manual
 * migration. Gated to mock mode so a production restart never drops live attestations.
 */
function wipeDevStateIfMock(): void {
  const clobHost = process.env.POLY_API_URL ?? "https://clob.polymarket.com";
  const isMock = clobHost.includes("localhost") || clobHost.includes("127.0.0.1");
  if (!isMock) return;
  const dbPath = process.env.SETTLEMENT_DB_PATH ?? path.join(process.cwd(), "settlement.db");
  const stateFile = path.join(process.cwd(), "data", "event-listener-state.json");
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, stateFile]) {
    try {
      fs.rmSync(f, { force: true });
    } catch (err) {
      logger.warn({ err, f }, "failed to wipe dev state file (non-fatal)");
    }
  }
  logger.info({ dbPath }, "DEV (mock CLOB): wiped per-chain signing-layer state on startup");
}

wipeDevStateIfMock();
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

/**
 * Production guard: the on-chain Vault.depositWallet is set once in initialize() and is
 * IMMUTABLE. Derive the deposit wallet address from the operator EOA via the relayer and assert
 * it equals DEPOSIT_WALLET_ADDRESS. A mismatch means JIT funding sends pUSD to one wallet while
 * orders/redeems use another (funds stranded, zero fills) — so surface it loudly. Non-fatal but
 * impossible to miss. Skipped in mock mode and when the relayer/address aren't configured.
 */
async function assertDepositWalletMatches(): Promise<void> {
  const clobHost = process.env.POLY_API_URL ?? "https://clob.polymarket.com";
  const isMock = clobHost.includes("localhost") || clobHost.includes("127.0.0.1");
  if (isMock || !config.polyRelayerUrl || !config.depositWalletAddress) return;
  try {
    const derived = await deriveDepositWalletAddress();
    if (derived.toLowerCase() !== config.depositWalletAddress.toLowerCase()) {
      logger.error(
        { derived, configured: config.depositWalletAddress },
        "DEPOSIT WALLET MISMATCH — relayer-derived address != DEPOSIT_WALLET_ADDRESS (immutable in the Vault). " +
          "JIT funding and redemptions will target the wrong wallet. Fix DEPOSIT_WALLET_ADDRESS / redeploy.",
      );
    } else {
      logger.info({ depositWallet: derived }, "deposit-wallet derive-and-assert OK");
    }
  } catch (err) {
    logger.warn({ err }, "deposit-wallet derive-and-assert check failed (non-fatal)");
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

  void assertDepositWalletMatches();
  void ensureDepositWalletApprovals();
  // Mirror the Polymarket market universe so the event listener can resolve each bet's
  // (market_id, outcome_side) → real CLOB tokenId before placing the order. Production-only;
  // no-op in mock mode. Started before the listener so the registry begins populating first.
  startMarketRegistrySync();
  // FC-6 / Option 4: proactively maintain a pUSD base buffer on the deposit wallet so most bets
  // spend already-indexed buying power (no per-bet wrap → no Polymarket indexing lag). Disabled by
  // default (BUFFER_LOW_WATER_USDC unset); JIT remains the overflow path. Started before the
  // listener so the buffer is warming as bets arrive.
  startBufferManager(provider, wallet);
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
  stopBufferManager();
  process.exit(0);
});

process.on("SIGINT", () => {
  logger.info("SIGINT received — shutting down");
  stopHeartbeat();
  stopFillTracker();
  stopBufferManager();
  process.exit(0);
});
