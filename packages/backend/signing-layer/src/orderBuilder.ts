import { ethers } from "ethers";
import Bottleneck from "bottleneck";
import pino from "pino";
import { config } from "./config.js";
import { checkResponse, isHalted } from "./circuitBreaker.js";

const logger = pino({ name: "order-builder" });

// Rate limiter — conservative defaults pending verification of actual Polymarket limits.
// See open-questions.md Q1: exact rate limits for POST /order must be confirmed.
const limiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 200, // max 5 orders/sec
  reservoir: 100,
  reservoirRefreshAmount: 100,
  reservoirRefreshInterval: 60 * 1000, // per minute
});

const VAULT_ABI = [
  "function reportFilled(bytes32 nullifier_of_bet) external",
  "function reportFOKFailure(bytes32 nullifier_of_bet) external",
];

interface BetAuthorizedEvent {
  nullifier: string;
  market_id: string;
  position_id: string;
  expected_shares: bigint;
  bet_amount: bigint;
  price: bigint;
  new_commitment: string;
}

export async function submitFOKOrder(
  event: BetAuthorizedEvent,
  wallet: ethers.Wallet,
  provider: ethers.JsonRpcProvider
): Promise<void> {
  if (isHalted()) {
    logger.warn({ nullifier: event.nullifier }, "Circuit breaker is active — skipping order");
    return;
  }

  await limiter.schedule(async () => {
    try {
      // ClobClient must be initialized with POLY_1271 signatureType (3)
      // so orders appear as signed by the vault EOA via ERC-1271.
      // Dynamic import allows the clob-client to be optional at dev time.
      const { ClobClient } = await import("@polymarket/clob-client-v2");
      const client = new ClobClient(
        "https://clob.polymarket.com",
        137, // Polygon mainnet chainId
        wallet,
        {
          key: config.polyApiKey,
          secret: config.polySecret,
          passphrase: config.polyPassphrase,
        },
        3 // POLY_1271 signature type
      );

      const orderArgs = {
        tokenId: event.position_id,
        price: Number(event.price) / 1e6, // price is in 6-decimal fixed point
        size: Number(event.bet_amount) / 1e6,
        side: "BUY" as const,
        orderType: "FOK" as const,
      };

      logger.info({ nullifier: event.nullifier, tokenId: event.position_id }, "Submitting FOK order");
      const resp = await client.createAndSendOrder(orderArgs);

      checkResponse(200, resp); // ClobClient throws on 403 — handle it defensively

      const vault = new ethers.Contract(config.vaultContractAddress, VAULT_ABI, wallet);

      if (resp && (resp as Record<string, unknown>)["status"] === "matched") {
        logger.info({ nullifier: event.nullifier }, "FOK order filled");
        const tx = await vault.reportFilled(event.nullifier);
        await tx.wait(1);
      } else {
        logger.warn({ nullifier: event.nullifier, resp }, "FOK order not filled");
        const tx = await vault.reportFOKFailure(event.nullifier);
        await tx.wait(1);
      }
    } catch (err: unknown) {
      // Check if the error is a 403
      const e = err as { status?: number; response?: { status?: number } };
      const status = e?.status ?? e?.response?.status;
      if (status !== undefined) checkResponse(status);
      logger.error({ err, nullifier: event.nullifier }, "Order submission failed");
    }
  });
}
