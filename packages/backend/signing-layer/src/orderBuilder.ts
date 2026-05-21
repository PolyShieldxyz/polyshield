import { ethers } from "ethers";
import Bottleneck from "bottleneck";
import pino from "pino";
import { config } from "./config";
import { checkResponse, isHalted } from "./circuitBreaker";

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
      const clobHost = process.env.POLY_API_URL ?? "https://clob.polymarket.com";
      const isMock = clobHost.includes("localhost") || clobHost.includes("127.0.0.1");
      logger.info({ clobHost, isMock }, "connecting to CLOB");

      let resp: Record<string, unknown>;

      if (isMock) {
        // Dev mode: raw fetch — mock CLOB doesn't validate signatures or require SDK init calls
        const res = await fetch(`${clobHost}/order`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            order: {
              tokenId: event.position_id,
              price: String(Number(event.price) / 1e6),
              makerAmount: String(Number(event.bet_amount) / 1e6),
              side: "BUY",
            },
            orderType: "FOK",
          }),
        });
        if (res.status === 403) { checkResponse(403); return; }
        resp = (await res.json()) as Record<string, unknown>;
      } else {
        // Production: full ClobClient with EIP-712 signing
        const { ClobClient, Chain, SignatureTypeV2, OrderType, Side } =
          await import("@polymarket/clob-client-v2");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const client = new ClobClient({
          host: clobHost,
          chain: Chain.POLYGON,
          // ethers.Wallet used here; production should switch to viem wallet client
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          signer: wallet as any,
          creds: {
            key: config.polyApiKey,
            secret: config.polySecret,
            passphrase: config.polyPassphrase,
          },
          signatureType: SignatureTypeV2.POLY_1271,
        });
        resp = (await client.createAndPostOrder({
          tokenID: event.position_id,   // capital D — Polymarket UserOrderV2 field
          price: Number(event.price) / 1e6,
          size: Number(event.bet_amount) / 1e6,
          side: Side.BUY,
          orderType: OrderType.FOK,
        } as unknown as Parameters<typeof client.createAndPostOrder>[0])) as Record<string, unknown>;
      }

      logger.info({ nullifier: event.nullifier, resp }, "CLOB response");

      const vault = new ethers.Contract(config.vaultContractAddress, VAULT_ABI, wallet);
      // Mock CLOB returns "MATCHED"; real CLOB returns "matched"
      const status = String(resp?.["status"] ?? "").toLowerCase();

      if (status === "matched") {
        logger.info({ nullifier: event.nullifier }, "FOK order filled — calling reportFilled");
        const tx = await (vault as ethers.Contract & { reportFilled: (n: string) => Promise<ethers.TransactionResponse> }).reportFilled(event.nullifier);
        await tx.wait(1);
        logger.info({ nullifier: event.nullifier }, "reportFilled confirmed");
      } else {
        logger.warn({ nullifier: event.nullifier, status }, "FOK order not filled — calling reportFOKFailure");
        const tx = await (vault as ethers.Contract & { reportFOKFailure: (n: string) => Promise<ethers.TransactionResponse> }).reportFOKFailure(event.nullifier);
        await tx.wait(1);
      }
    } catch (err: unknown) {
      const e = err as { status?: number; response?: { status?: number } };
      const httpStatus = e?.status ?? e?.response?.status;
      if (httpStatus !== undefined) checkResponse(httpStatus);
      logger.error({ err, nullifier: event.nullifier }, "Order submission failed");
    }
  });
}
