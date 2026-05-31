import { ethers } from "ethers";
import Bottleneck from "bottleneck";
import pino from "pino";
import { config } from "./config";
import { checkResponse, isHalted } from "./circuitBreaker";
import { signingLayerNonceManager } from "./nonceManager";

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
  "function reportSold(bytes32 nullifier_of_bet, uint64 sold_shares, uint64 proceeds) external",
  "function reportResting(bytes32 nullifier_of_bet) external",
  "function reportPartialFill(bytes32 nullifier_of_bet, uint64 filled_shares, uint64 spent_amount) external",
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

// FC-4: parameters for a resting GTC/GTD limit order (vs the default FOK).
export interface LimitOrderParams {
  orderType: "GTC" | "GTD";
  /** GTD effective lifetime in seconds (ignored for GTC). */
  expiration: number;
}

interface RestingOrderState {
  status: string;
  filledShares: number;
  spentAmount: number;
}

// FC-1: a depositor's request to sell shares of an open position before settlement.
export interface CloseRequest {
  nullifier_of_bet: string;
  position_id: string;
  /** Shares to sell, 1e6-scaled (matches expected_shares units). */
  sold_shares: bigint;
  /** User-chosen FOK SELL limit price, 1e6-scaled (0..1e6). */
  limit_price: bigint;
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
          // Required for POLY_1271: maker/signer must be deposit wallet, not operator EOA.
          funderAddress: config.depositWalletAddress,
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
        const tx = await signingLayerNonceManager.send(provider, wallet, (nonce) =>
          (vault as ethers.Contract & { reportFilled: (n: string, o: ethers.Overrides) => Promise<ethers.TransactionResponse> })
            .reportFilled(event.nullifier, { nonce })
        );
        await tx.wait(1);
        logger.info({ nullifier: event.nullifier }, "reportFilled confirmed");
      } else {
        logger.warn({ nullifier: event.nullifier, status }, "FOK order not filled — calling reportFOKFailure");
        const tx = await signingLayerNonceManager.send(provider, wallet, (nonce) =>
          (vault as ethers.Contract & { reportFOKFailure: (n: string, o: ethers.Overrides) => Promise<ethers.TransactionResponse> })
            .reportFOKFailure(event.nullifier, { nonce })
        );
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

// FC-1: submit a FOK SELL to close (fully or partially) an open position before
// settlement. On fill, report the realized proceeds via reportSold so the depositor
// can credit their note with a closePosition proof. On no-fill nothing is debited and
// the position simply stays open (FILLED) — no recovery proof is needed.
export async function submitFOKSellOrder(
  req: CloseRequest,
  wallet: ethers.Wallet,
  provider: ethers.JsonRpcProvider
): Promise<void> {
  if (isHalted()) {
    logger.warn({ nullifier_of_bet: req.nullifier_of_bet }, "Circuit breaker is active — skipping close");
    return;
  }

  await limiter.schedule(async () => {
    try {
      const clobHost = process.env.POLY_API_URL ?? "https://clob.polymarket.com";
      const isMock = clobHost.includes("localhost") || clobHost.includes("127.0.0.1");

      let resp: Record<string, unknown>;
      if (isMock) {
        const res = await fetch(`${clobHost}/order`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            order: {
              tokenId: req.position_id,
              price: String(Number(req.limit_price) / 1e6),
              makerAmount: String(Number(req.sold_shares) / 1e6),
              side: "SELL",
            },
            orderType: "FOK",
          }),
        });
        if (res.status === 403) { checkResponse(403); return; }
        resp = (await res.json()) as Record<string, unknown>;
      } else {
        const { ClobClient, Chain, SignatureTypeV2, OrderType, Side } =
          await import("@polymarket/clob-client-v2");
        const client = new ClobClient({
          host: clobHost,
          chain: Chain.POLYGON,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          signer: wallet as any,
          creds: {
            key: config.polyApiKey,
            secret: config.polySecret,
            passphrase: config.polyPassphrase,
          },
          signatureType: SignatureTypeV2.POLY_1271,
          funderAddress: config.depositWalletAddress,
        });
        resp = (await client.createAndPostOrder({
          tokenID: req.position_id,
          price: Number(req.limit_price) / 1e6,
          size: Number(req.sold_shares) / 1e6,
          side: Side.SELL,
          orderType: OrderType.FOK,
        } as unknown as Parameters<typeof client.createAndPostOrder>[0])) as Record<string, unknown>;
      }

      logger.info({ nullifier_of_bet: req.nullifier_of_bet, resp }, "CLOB SELL response");

      const status = String(resp?.["status"] ?? "").toLowerCase();
      if (status !== "matched") {
        logger.warn({ nullifier_of_bet: req.nullifier_of_bet, status }, "FOK SELL not filled — position stays open");
        return;
      }

      // Proceeds = sold_shares * limit_price / 1e6 (both 1e6-scaled → USDC 6dp).
      // Operator-reported (FC-1 v1 trust class). Production should read the realized
      // fill proceeds from the trade response when price improvement is possible.
      const proceeds = (req.sold_shares * req.limit_price) / 1_000_000n;

      const vault = new ethers.Contract(config.vaultContractAddress, VAULT_ABI, wallet);
      logger.info({ nullifier_of_bet: req.nullifier_of_bet, sold_shares: req.sold_shares.toString(), proceeds: proceeds.toString() }, "FOK SELL filled — calling reportSold");
      const tx = await signingLayerNonceManager.send(provider, wallet, (nonce) =>
        (vault as ethers.Contract & { reportSold: (n: string, s: bigint, p: bigint, o: ethers.Overrides) => Promise<ethers.TransactionResponse> })
          .reportSold(req.nullifier_of_bet, req.sold_shares, proceeds, { nonce })
      );
      await tx.wait(1);
      logger.info({ nullifier_of_bet: req.nullifier_of_bet }, "reportSold confirmed");
    } catch (err: unknown) {
      const e = err as { status?: number; response?: { status?: number } };
      const httpStatus = e?.status ?? e?.response?.status;
      if (httpStatus !== undefined) checkResponse(httpStatus);
      logger.error({ err, nullifier_of_bet: req.nullifier_of_bet }, "Close (SELL) submission failed");
    }
  });
}

const LIMIT_POLL_INTERVAL_MS = 2_000;
const LIMIT_POLL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * FC-4: poll the mock CLOB's GET /order/:id until the resting order reaches a
 * terminal lifecycle state. Returns null on timeout (order left resting). The
 * production path streams fills over the authenticated User-Channel websocket —
 * deferred per future-changes.md; this REST poll is the doc-sanctioned fallback.
 */
async function pollRestingOrder(clobHost: string, orderID: string): Promise<RestingOrderState | null> {
  const start = Date.now();
  while (Date.now() - start < LIMIT_POLL_TIMEOUT_MS) {
    try {
      const res = await fetch(`${clobHost}/order/${orderID}`);
      if (res.ok) {
        const o = (await res.json()) as RestingOrderState;
        if (o.status && o.status !== "live") return o;
      }
    } catch (err) {
      logger.warn({ err, orderID }, "limit order poll error — retrying");
    }
    await new Promise((r) => setTimeout(r, LIMIT_POLL_INTERVAL_MS));
  }
  return null;
}

/**
 * FC-4: submit a resting GTC/GTD limit BUY order (Flow B — the full bet_amount was
 * already debited on-chain by authorizeBet). On a "live" ack the operator marks the
 * bet RESTING; the order is then polled to terminal and mapped onto exactly one
 * report:
 *   fully filled            → reportFilled        (settlement proceeds as today)
 *   partially then ended    → reportPartialFill   (user reclaims the remainder via partialFillCredit)
 *   zero filled (expired)   → reportFOKFailure    (user reclaims all via betCancellationCredit)
 */
export async function submitLimitOrder(
  event: BetAuthorizedEvent,
  params: LimitOrderParams,
  wallet: ethers.Wallet,
  provider: ethers.JsonRpcProvider
): Promise<void> {
  if (isHalted()) {
    logger.warn({ nullifier: event.nullifier }, "Circuit breaker is active — skipping limit order");
    return;
  }

  await limiter.schedule(async () => {
    const vault = new ethers.Contract(config.vaultContractAddress, VAULT_ABI, wallet);
    try {
      const clobHost = process.env.POLY_API_URL ?? "https://clob.polymarket.com";
      const isMock = clobHost.includes("localhost") || clobHost.includes("127.0.0.1");
      logger.info({ clobHost, isMock, orderType: params.orderType }, "submitting limit order");

      if (!isMock) {
        // Production GTC/GTD submission + websocket fill tracking is deferred
        // (future-changes.md FC-4: gated on live-Polymarket-API validation).
        logger.warn(
          { nullifier: event.nullifier },
          "production limit-order lifecycle (websocket) not yet wired — skipping"
        );
        return;
      }

      // GTD effective lifetime: now + 60s security threshold + N (Polymarket convention).
      const expiration =
        params.orderType === "GTD" ? Math.floor(Date.now() / 1000) + 60 + params.expiration : 0;

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
          orderType: params.orderType,
          expiration,
        }),
      });
      if (res.status === 403) { checkResponse(403); return; }
      const resp = (await res.json()) as Record<string, unknown>;
      const orderID = typeof resp["orderID"] === "string" ? (resp["orderID"] as string) : undefined;
      const initialStatus = String(resp["status"] ?? "").toLowerCase();
      logger.info({ nullifier: event.nullifier, orderID, initialStatus }, "limit order CLOB response");

      // Resting on the book → operator confirms RESTING (exempt from adminCancelBet).
      if (initialStatus === "live") {
        const tx = await signingLayerNonceManager.send(provider, wallet, (nonce) =>
          (vault as ethers.Contract & { reportResting: (n: string, o: ethers.Overrides) => Promise<ethers.TransactionResponse> })
            .reportResting(event.nullifier, { nonce })
        );
        await tx.wait(1);
        logger.info({ nullifier: event.nullifier }, "reportResting confirmed");
      }

      if (!orderID) {
        logger.warn({ nullifier: event.nullifier }, "limit order returned no orderID — cannot track fills");
        return;
      }

      const terminal = await pollRestingOrder(clobHost, orderID);
      if (!terminal) {
        logger.warn({ nullifier: event.nullifier, orderID }, "limit order poll timed out — leaving RESTING");
        return;
      }
      logger.info({ nullifier: event.nullifier, terminal }, "limit order reached terminal state");

      if (terminal.status === "matched") {
        const tx = await signingLayerNonceManager.send(provider, wallet, (nonce) =>
          (vault as ethers.Contract & { reportFilled: (n: string, o: ethers.Overrides) => Promise<ethers.TransactionResponse> })
            .reportFilled(event.nullifier, { nonce })
        );
        await tx.wait(1);
        logger.info({ nullifier: event.nullifier }, "limit order fully filled — reportFilled confirmed");
      } else if (terminal.status === "partial") {
        const filledShares = BigInt(Math.floor(terminal.filledShares));
        const spentAmount = BigInt(Math.floor(terminal.spentAmount));
        const tx = await signingLayerNonceManager.send(provider, wallet, (nonce) =>
          (vault as ethers.Contract & {
            reportPartialFill: (n: string, f: bigint, s: bigint, o: ethers.Overrides) => Promise<ethers.TransactionResponse>
          }).reportPartialFill(event.nullifier, filledShares, spentAmount, { nonce })
        );
        await tx.wait(1);
        logger.info(
          { nullifier: event.nullifier, filledShares: filledShares.toString(), spentAmount: spentAmount.toString() },
          "limit order partially filled — reportPartialFill confirmed"
        );
      } else {
        // cancelled / zero-fill → reuse the FOK-failure recovery path.
        const tx = await signingLayerNonceManager.send(provider, wallet, (nonce) =>
          (vault as ethers.Contract & { reportFOKFailure: (n: string, o: ethers.Overrides) => Promise<ethers.TransactionResponse> })
            .reportFOKFailure(event.nullifier, { nonce })
        );
        await tx.wait(1);
        logger.info({ nullifier: event.nullifier }, "limit order zero-filled — reportFOKFailure confirmed");
      }
    } catch (err: unknown) {
      const e = err as { status?: number; response?: { status?: number } };
      const httpStatus = e?.status ?? e?.response?.status;
      if (httpStatus !== undefined) checkResponse(httpStatus);
      logger.error({ err, nullifier: event.nullifier }, "Limit order submission failed");
    }
  });
}
