import { ethers } from "ethers";
import Bottleneck from "bottleneck";
import pino from "pino";
import { config } from "./config";
import { checkResponse, isHalted } from "./circuitBreaker";
import { ensureDepositWalletFunded } from "./jitFunding";
import {
  ReportType,
  signAndStoreAttestation,
  getAttestationDomainParams,
  markResting,
} from "./attestationStore";
import { attestTerminal } from "./terminalAttestation";
import { trackOrder } from "./wsFillTracker";

const logger = pino({ name: "order-builder" });

/**
 * FC-9: sign + persist an OperatorAttestation about a bet's terminal outcome
 * instead of sending an on-chain report* tx (the Vault no longer has those). The
 * store is single-write/idempotent, so a re-run after a missed event safely
 * returns the existing attestation rather than re-signing. Defensive — logs and
 * swallows on error rather than crashing the order path.
 */
async function attest(
  wallet: ethers.Wallet,
  nullifierOfBet: string,
  reportType: ReportType,
  amountA: bigint,
  amountB: bigint,
): Promise<void> {
  try {
    await signAndStoreAttestation(wallet, getAttestationDomainParams(), {
      nullifierOfBet,
      reportType,
      amountA,
      amountB,
    });
    logger.info(
      { nullifier: nullifierOfBet, reportType, amountA: amountA.toString(), amountB: amountB.toString() },
      "operator attestation signed + persisted",
    );
  } catch (err) {
    logger.error({ err, nullifier: nullifierOfBet, reportType }, "signAndStoreAttestation errored");
  }
}

/**
 * Attest a bet as a FOK failure (recoverable: the user reclaims their note via
 * betCancellationCredit) when JIT funding cannot place the order.
 */
async function reportFOKFailureSafe(
  _provider: ethers.JsonRpcProvider,
  wallet: ethers.Wallet,
  nullifier: string,
): Promise<void> {
  await attest(wallet, nullifier, ReportType.FAILED, 0n, 0n);
}

// API-010: lazily-created production ClobClient, cached so the heartbeat reuses one
// authenticated session instead of constructing a client every 5s. Typed loosely
// because the SDK is dynamically imported (see submitFOKOrder).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _clobClient: any = null;

/**
 * API-010: get-or-create the production ClobClient used for order submission and
 * heartbeats. Returns null in mock mode (the mock CLOB needs no SDK init). Wrapped
 * by callers in try/catch — never throws on construction beyond the SDK import.
 */
export async function getOrCreateClobClient(
  wallet: ethers.Wallet,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any | null> {
  const clobHost = process.env.POLY_API_URL ?? "https://clob.polymarket.com";
  const isMock = clobHost.includes("localhost") || clobHost.includes("127.0.0.1");
  if (isMock) return null;
  if (_clobClient) return _clobClient;

  const { ClobClient, Chain, SignatureTypeV2 } = await import("@polymarket/clob-client-v2");
  _clobClient = new ClobClient({
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
  return _clobClient;
}

/**
 * API-010: best-effort heartbeat. Pings the CLOB and routes the result through the
 * circuit breaker so a 403 / ACCOUNT_FLAGGED halts all signing. Defensive by design:
 * any failure to obtain the client or call the heartbeat method is logged and
 * swallowed (returns "") rather than crashing the signing layer.
 */
export async function sendHeartbeat(wallet: ethers.Wallet): Promise<string> {
  const clobHost = process.env.POLY_API_URL ?? "https://clob.polymarket.com";
  const isMock = clobHost.includes("localhost") || clobHost.includes("127.0.0.1");
  try {
    if (isMock) {
      // Mock CLOB exposes POST /heartbeat → { heartbeat_id }.
      const res = await fetch(`${clobHost}/heartbeat`, { method: "POST" });
      let body: unknown = undefined;
      try {
        body = await res.json();
      } catch {
        // non-JSON body — ignore for breaker purposes
      }
      checkResponse(res.status, body); // halts on 403 / ACCOUNT_FLAGGED
      const b = (body ?? {}) as Record<string, unknown>;
      return typeof b["heartbeat_id"] === "string" ? (b["heartbeat_id"] as string) : "";
    }

    const client = await getOrCreateClobClient(wallet);
    if (!client || typeof client.postHeartbeat !== "function") {
      logger.warn("heartbeat: clob client or postHeartbeat unavailable — skipping");
      return "";
    }
    // clob-client-v2: postHeartbeat() → { heartbeat_id, error_msg? }
    const resp = (await client.postHeartbeat()) as { heartbeat_id?: string; error_msg?: string };
    // The SDK resolves on a flagged account with an error_msg rather than throwing;
    // surface that to the breaker (status 200, body carries the flag) defensively.
    if (resp?.error_msg) checkResponse(200, { error: resp.error_msg });
    return resp?.heartbeat_id ?? "";
  } catch (err: unknown) {
    const e = err as { status?: number; response?: { status?: number; data?: unknown } };
    const httpStatus = e?.status ?? e?.response?.status;
    if (httpStatus !== undefined) checkResponse(httpStatus, e?.response?.data);
    logger.warn({ err }, "heartbeat failed (best-effort) — continuing");
    return "";
  }
}

/**
 * Format a 1e6-scaled bigint (micro-USDC / 1e6-scaled shares) as a plain decimal
 * string without precision loss. Avoids `Number(x) / 1e6`, which silently rounds
 * once the integer part exceeds 2^53. Used for mock CLOB order bodies.
 */
export function microToDecimal(x: bigint): string {
  const sign = x < 0n ? "-" : "";
  const abs = x < 0n ? -x : x;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac.length > 0 ? `${sign}${whole}.${frac}` : `${sign}${whole}`;
}

// Rate limiter — conservative defaults pending verification of actual Polymarket limits.
// See open-questions.md Q1: exact rate limits for POST /order must be confirmed.
const limiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 200, // max 5 orders/sec
  reservoir: 100,
  reservoirRefreshAmount: 100,
  reservoirRefreshInterval: 60 * 1000, // per minute
});

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

  // Option-3 (JIT): fund the deposit wallet just-in-time before submitting. If funding
  // is unavailable (deployment cap reached / vault illiquid), report a FOK failure so
  // the user's note stays recoverable rather than silently debited.
  const funded = await ensureDepositWalletFunded(provider, wallet, event.bet_amount);
  if (!funded) {
    logger.warn({ nullifier: event.nullifier }, "JIT funding unavailable — reporting FOK failure (recoverable)");
    await reportFOKFailureSafe(provider, wallet, event.nullifier);
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
              price: microToDecimal(event.price),
              makerAmount: microToDecimal(event.bet_amount),
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

      // Mock CLOB returns "MATCHED"; real CLOB returns "matched"
      const status = String(resp?.["status"] ?? "").toLowerCase();

      if (status === "matched") {
        logger.info({ nullifier: event.nullifier }, "FOK order filled — attesting FILLED");
        await attest(wallet, event.nullifier, ReportType.FILLED, 0n, 0n);
      } else {
        logger.warn({ nullifier: event.nullifier, status }, "FOK order not filled — attesting FAILED");
        await attest(wallet, event.nullifier, ReportType.FAILED, 0n, 0n);
      }
    } catch (err: unknown) {
      const e = err as { status?: number; response?: { status?: number } };
      const httpStatus = e?.status ?? e?.response?.status;
      if (httpStatus !== undefined) checkResponse(httpStatus);
      logger.error({ err, nullifier: event.nullifier }, "Order submission failed");
    }
  });
}

/**
 * FAK (Fill-And-Kill): a market BUY that fills immediately against the book and kills
 * any unfilled remainder. Unlike FOK (all-or-nothing) the result may be a partial fill,
 * so it maps onto the full FC-4/FC-9 terminal set via attestTerminal:
 *   matched (full)        → FILLED  (settlement proceeds as today)
 *   partial               → PARTIAL (user reclaims the remainder via partialFillCredit)
 *   unmatched (zero fill)  → FAILED  (user reclaims all via betCancellationCredit)
 * FAK is synchronous — its fill result is returned in the POST response, so (unlike a
 * resting GTC/GTD order) no websocket tracking is needed.
 */
export async function submitFAKOrder(
  event: BetAuthorizedEvent,
  wallet: ethers.Wallet,
  provider: ethers.JsonRpcProvider
): Promise<void> {
  if (isHalted()) {
    logger.warn({ nullifier: event.nullifier }, "Circuit breaker is active — skipping FAK order");
    return;
  }

  // Option-3 (JIT): fund the deposit wallet just-in-time before submitting. On failure
  // report a recoverable FOK failure (the note stays reclaimable).
  const funded = await ensureDepositWalletFunded(provider, wallet, event.bet_amount);
  if (!funded) {
    logger.warn({ nullifier: event.nullifier }, "JIT funding unavailable — reporting failure (recoverable)");
    await reportFOKFailureSafe(provider, wallet, event.nullifier);
    return;
  }

  await limiter.schedule(async () => {
    try {
      const clobHost = process.env.POLY_API_URL ?? "https://clob.polymarket.com";
      const isMock = clobHost.includes("localhost") || clobHost.includes("127.0.0.1");
      logger.info({ clobHost, isMock }, "submitting FAK order");

      let resp: Record<string, unknown>;
      if (isMock) {
        const res = await fetch(`${clobHost}/order`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            order: {
              tokenId: event.position_id,
              price: microToDecimal(event.price),
              makerAmount: microToDecimal(event.bet_amount),
              side: "BUY",
            },
            orderType: "FAK",
          }),
        });
        if (res.status === 403) { checkResponse(403); return; }
        resp = (await res.json()) as Record<string, unknown>;
      } else {
        const { OrderType, Side } = await import("@polymarket/clob-client-v2");
        const client = await getOrCreateClobClient(wallet);
        if (!client) { logger.error("FAK: clob client unavailable"); return; }
        resp = (await client.createAndPostOrder({
          tokenID: event.position_id,
          price: Number(event.price) / 1e6,
          size: Number(event.bet_amount) / 1e6,
          side: Side.BUY,
          orderType: OrderType.FAK,
        } as unknown as Parameters<typeof client.createAndPostOrder>[0])) as Record<string, unknown>;
      }

      logger.info({ nullifier: event.nullifier, resp }, "FAK CLOB response");

      const status = String(resp?.["status"] ?? "").toLowerCase();
      // Mock returns filledShares/spentAmount (1e6-scaled). Production carries a matched
      // size; for a partial, derive spent from the limit price as a best-effort fallback.
      let filledShares = 0n;
      let spentAmount = 0n;
      if (typeof resp["filledShares"] === "number" && typeof resp["spentAmount"] === "number") {
        filledShares = BigInt(Math.floor(resp["filledShares"] as number));
        spentAmount = BigInt(Math.floor(resp["spentAmount"] as number));
      } else if (resp["size_matched"] !== undefined) {
        const shares = Number(resp["size_matched"]);
        filledShares = BigInt(Math.floor(shares * 1e6));
        spentAmount = (filledShares * event.price) / 1_000_000n;
      }

      await attestTerminal(
        wallet,
        { nullifier: event.nullifier, expected_shares: event.expected_shares, bet_amount: event.bet_amount },
        status,
        filledShares,
        spentAmount,
      );
    } catch (err: unknown) {
      const e = err as { status?: number; response?: { status?: number } };
      const httpStatus = e?.status ?? e?.response?.status;
      if (httpStatus !== undefined) checkResponse(httpStatus);
      logger.error({ err, nullifier: event.nullifier }, "FAK order submission failed");
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
              price: microToDecimal(req.limit_price),
              makerAmount: microToDecimal(req.sold_shares),
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

      logger.info({ nullifier_of_bet: req.nullifier_of_bet, sold_shares: req.sold_shares.toString(), proceeds: proceeds.toString() }, "FOK SELL filled — attesting SOLD");
      // SOLD: amountA = sold_shares, amountB = proceeds.
      await attest(wallet, req.nullifier_of_bet, ReportType.SOLD, req.sold_shares, proceeds);
    } catch (err: unknown) {
      const e = err as { status?: number; response?: { status?: number } };
      const httpStatus = e?.status ?? e?.response?.status;
      if (httpStatus !== undefined) checkResponse(httpStatus);
      logger.error({ err, nullifier_of_bet: req.nullifier_of_bet }, "Close (SELL) submission failed");
    }
  });
}

/**
 * FC-4 + FC-9: submit a resting GTC/GTD limit BUY order (Flow B — the full bet_amount
 * was already debited on-chain by authorizeBet). On a "live" ack we record a
 * non-binding RESTING UI signal (no on-chain tx — reportResting is gone) and register
 * the order with the websocket fill tracker, which drives the eventual terminal
 * attestation asynchronously (user-channel websocket, with REST reconcile as backstop):
 *   fully filled            → FILLED   (settlement proceeds as today)
 *   partially then ended    → PARTIAL  (user reclaims the remainder via partialFillCredit)
 *   zero filled (expired)   → FAILED   (user reclaims all via betCancellationCredit)
 *
 * The same code runs in mock and production; only POLY_API_URL / POLY_WS_URL differ.
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

  // Option-3 (JIT): a resting limit order still needs buying power on the deposit
  // wallet the moment it can fill, so fund just-in-time at submit (the full bet_amount
  // was already debited on-chain by authorizeBet). If unfunded, fail recoverably.
  const funded = await ensureDepositWalletFunded(provider, wallet, event.bet_amount);
  if (!funded) {
    logger.warn({ nullifier: event.nullifier }, "JIT funding unavailable — reporting FOK failure (recoverable)");
    await reportFOKFailureSafe(provider, wallet, event.nullifier);
    return;
  }

  await limiter.schedule(async () => {
    try {
      const clobHost = process.env.POLY_API_URL ?? "https://clob.polymarket.com";
      const isMock = clobHost.includes("localhost") || clobHost.includes("127.0.0.1");
      logger.info({ clobHost, isMock, orderType: params.orderType }, "submitting limit order");

      // GTD effective lifetime: now + 60s security threshold + N (Polymarket convention).
      const expiration =
        params.orderType === "GTD" ? Math.floor(Date.now() / 1000) + 60 + params.expiration : 0;

      let resp: Record<string, unknown>;
      if (isMock) {
        const res = await fetch(`${clobHost}/order`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            order: {
              tokenId: event.position_id,
              price: microToDecimal(event.price),
              makerAmount: microToDecimal(event.bet_amount),
              side: "BUY",
            },
            orderType: params.orderType,
            expiration,
          }),
        });
        if (res.status === 403) { checkResponse(403); return; }
        resp = (await res.json()) as Record<string, unknown>;
      } else {
        const { OrderType, Side } = await import("@polymarket/clob-client-v2");
        const client = await getOrCreateClobClient(wallet);
        if (!client) { logger.error("limit order: clob client unavailable"); return; }
        resp = (await client.createAndPostOrder({
          tokenID: event.position_id,
          price: Number(event.price) / 1e6,
          size: Number(event.bet_amount) / 1e6,
          side: Side.BUY,
          orderType: params.orderType === "GTD" ? OrderType.GTD : OrderType.GTC,
          expiration,
        } as unknown as Parameters<typeof client.createAndPostOrder>[0])) as Record<string, unknown>;
      }

      const orderID =
        (typeof resp["orderID"] === "string" && (resp["orderID"] as string)) ||
        (typeof resp["orderId"] === "string" && (resp["orderId"] as string)) ||
        (typeof resp["id"] === "string" && (resp["id"] as string)) ||
        undefined;
      const initialStatus = String(resp["status"] ?? "").toLowerCase();
      logger.info({ nullifier: event.nullifier, orderID, initialStatus }, "limit order CLOB response");

      // Resting on the book → record a non-binding UI signal only. FC-9: RESTING is
      // no longer on-chain, so nothing is signed or sent here.
      if (initialStatus === "live") {
        markResting(event.nullifier);
        logger.info({ nullifier: event.nullifier }, "limit order live — recorded RESTING (non-binding UI signal)");
      }

      if (!orderID) {
        logger.warn({ nullifier: event.nullifier }, "limit order returned no orderID — cannot track fills");
        return;
      }

      // Hand off to the async fill tracker. It maps the order's terminal state onto
      // exactly one operator attestation over the user-channel websocket, with a REST
      // reconcile backstop. submitLimitOrder returns immediately (no blocking poll).
      trackOrder({
        nullifier: event.nullifier,
        orderID,
        conditionId: event.market_id,
        tokenId: event.position_id,
        expected_shares: event.expected_shares,
        bet_amount: event.bet_amount,
        price: event.price,
        orderType: params.orderType,
        expiration,
      });
    } catch (err: unknown) {
      const e = err as { status?: number; response?: { status?: number } };
      const httpStatus = e?.status ?? e?.response?.status;
      if (httpStatus !== undefined) checkResponse(httpStatus);
      logger.error({ err, nullifier: event.nullifier }, "Limit order submission failed");
    }
  });
}
