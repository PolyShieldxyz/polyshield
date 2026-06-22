import { ethers } from "ethers";
import Bottleneck from "bottleneck";
import pino from "pino";
import { config } from "./config";
import { getClobBuilderConfig } from "./builderConfig";
import { checkResponse, isHalted } from "./circuitBreaker";
import { ensureDepositWalletFunded } from "./jitFunding";
import {
  ReportType,
  signAndStoreAttestation,
  getAttestationDomainParams,
  markResting,
  getAttestation,
  markMarketSubmitting,
  setMarketOrderId,
  type MarketSubmission,
} from "./attestationStore";
import { attestTerminal } from "./terminalAttestation";
import { trackOrder, isOrderTracked } from "./wsFillTracker";
import { resolveToken } from "./marketRegistry";
import { getClobCreds } from "./clobAuth";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

const logger = pino({ name: "order-builder" });

// clob-client-v2 expects a viem WalletClient as its `signer` (it reads `signer.account.address`
// via getWalletClientAddress). Passing an ethers.Wallet throws "wallet client is missing account
// address" and blocks every order + heartbeat. Build the viem client once from the operator EOA
// key and reuse it. (The ethers `wallet` is still used elsewhere for on-chain attestation signing.)
let _viemSigner: ReturnType<typeof createWalletClient> | null = null;
function getClobSigner(): ReturnType<typeof createWalletClient> {
  if (_viemSigner) return _viemSigner;
  const raw = config.vaultEoaPrivateKey;
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
  _viemSigner = createWalletClient({
    account: privateKeyToAccount(key),
    chain: polygon,
    transport: http(process.env.POLYGON_RPC_URL ?? "https://polygon-bor-rpc.publicnode.com"),
  });
  return _viemSigner;
}

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

// A FAK submission completes in seconds. A market-submission marker with NO orderId that is older
// than this is a dead submission whose order was never placed (a FAK never rests) → safe to FAILED so
// the stake is reclaimable. Generous so any real submit has definitively finished.
const STALE_SUBMISSION_SEC = 300;

/**
 * Operator-driven FAILED attestation for a bet with NO live CLOB order (never placed / rejected
 * / user-cancelled-before-resting). Makes the stake reclaimable via betCancellationCredit. Safe
 * only when there is no resting order that could still fill — callers must verify that first.
 */
export async function attestFailedFor(wallet: ethers.Wallet, nullifier: string): Promise<void> {
  await attest(wallet, nullifier, ReportType.FAILED, 0n, 0n);
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

  // L2 creds DERIVED from the operator wallet (shared with the ws fill tracker via clobAuth) —
  // the static POLY_API_* env creds are rejected by the CLOB ("Invalid api key").
  const creds = await getClobCreds();

  _clobClient = new ClobClient({
    host: clobHost,
    chain: Chain.POLYGON,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signer: getClobSigner() as any,
    creds,
    signatureType: SignatureTypeV2.POLY_1271,
    funderAddress: config.depositWalletAddress,
    // Builder attribution (order.builder) — undefined when POLY_BUILDER_CODE unset → default path.
    builderConfig: getClobBuilderConfig(),
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

const PUSD_BAL_ABI = ["function balanceOf(address) view returns (uint256)"];

// FC-11: betRecords getter — the close (FOK SELL) path reads the bet's on-chain
// (market_id, outcome_side) to resolve the REAL CLOB tokenId via the market registry, exactly as
// the BUY path does in the event listener. The close request only carries the SYNTHETIC on-chain
// position_id, which the CLOB does not recognize.
const BET_RECORDS_ABI = [
  "function betRecords(bytes32 nullifier) view returns (bytes32 market_id, bytes32 condition_id, bytes32 position_id, uint64 expected_shares, uint64 bet_amount, uint8 outcome_side, uint8 status)",
];

/**
 * Build a BUY order's (price, size) so its cost never exceeds the budget — the user's stake
 * (bet_amount) AND the deposit wallet's actual pUSD balance, whichever is smaller.
 *
 * The CLOB rounds the limit price UP to the market's tick (e.g. 0.0175 → 0.018) and computes
 * cost at the ROUNDED price, so sizing against the raw price overshoots and the whole order
 * reverts ("not enough balance … order amount > balance"). We therefore (1) fetch the tick,
 * (2) round the price up to it and send that exact price so the CLOB does no further rounding,
 * (3) size = floor(budget / roundedPrice) to the 0.01 share tick → cost ≤ budget by
 * construction. As close to the stake as possible, never reverting.
 */
async function budgetedBuyOrder(
  provider: ethers.JsonRpcProvider,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  event: BetAuthorizedEvent,
): Promise<{ price: number; size: number }> {
  const rawPrice = Number(event.price) / 1e8;

  // Market tick (e.g. 0.01 / 0.001). Fall back to 0.001 (Polymarket's finest) if the read fails.
  let tick = 0.001;
  try {
    const t = Number(await client.getTickSize(event.position_id));
    if (Number.isFinite(t) && t > 0) tick = t;
  } catch (err) {
    logger.warn({ err: String(err) }, "budgetedBuyOrder: getTickSize failed — defaulting tick=0.001");
  }
  // Round the buy price UP to the tick (match the CLOB) and pin it on-tick so cost = size×price.
  const price = Number((Math.ceil(rawPrice / tick - 1e-9) * tick).toFixed(6));

  // Budget = min(stake, actual pUSD balance). The CLOB taker fee is reserved AFTER the balance caps
  // below, using Polymarket's EXACT per-market fee (it is NOT a flat rate).
  let budgetUsd = Number(event.bet_amount) / 1e6;
  try {
    if (config.pusdAddress && config.depositWalletAddress) {
      const pusd = new ethers.Contract(config.pusdAddress, PUSD_BAL_ABI, provider);
      const balUsd = Number((await pusd.balanceOf(config.depositWalletAddress)) as bigint) / 1e6;
      if (balUsd < budgetUsd) budgetUsd = balUsd;
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "budgetedBuyOrder: pUSD balance read failed — using bet_amount as budget");
  }

  // L2: also floor the budget at the CLOB's OWN view of the deposit wallet's collateral balance.
  // After a JIT USDC→pUSD wrap the chain shows the new pUSD but the Polymarket backend may not have
  // indexed it yet, so sizing against the chain balance overshoots what the CLOB will accept and the
  // order is rejected ("not enough balance"). Sizing against the CLOB-visible balance fills smaller
  // (which L3 reconciles) instead of failing. Only downsize to a POSITIVE CLOB balance — a transient
  // 0 right after a wrap shouldn't zero out a funded order. Best-effort: skip in mock / degrade on
  // error. TODO(L2): confirm the clob-client-v2 asset_type enum for pUSD collateral + balance units.
  try {
    if (typeof client?.getBalanceAllowance === "function") {
      const ba = await client.getBalanceAllowance({ asset_type: "COLLATERAL" });
      const clobUsd = Number(ba?.balance ?? NaN) / 1e6;
      if (Number.isFinite(clobUsd) && clobUsd > 0 && clobUsd < budgetUsd) budgetUsd = clobUsd;
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "budgetedBuyOrder: getBalanceAllowance failed — sizing against chain balance");
  }

  // Reserve Polymarket's taker fee from the budget so order_cost + fee <= budget (else the CLOB
  // rejects "not enough balance to cover the fee estimate"). The fee is VARIABLE — price-dependent
  // (∝ p·(1−p), peaks at 0.5, ~0 at the tails) and per-market/category (per-token `rate`; some
  // categories like geopolitical are fee-FREE) — so reuse the SDK's OWN formula + per-market
  // `feeInfos` rather than a flat bps. A market BUY is always a taker (makers pay no fee). The user
  // pays this fee from their stake (gone, not refunded — see marketSpentWithFee). Falls back to
  // config.clobBuyFeeBps only if the per-market fee can't be fetched. (event.position_id is the REAL
  // tokenId here — resolved by the event listener — so feeInfos keys on the right market.)
  let feeBudgetUsd = budgetUsd;
  try {
    const { adjustBuyAmountForFees } = await import("@polymarket/clob-client-v2");
    await client.getFeeExponent(event.position_id); // ensures feeInfos[tokenId] is cached (getMarket)
    const fi = client.feeInfos?.[event.position_id];
    const builderTaker = config.polyBuilderCode
      ? Number(client.builderFeeRates?.[config.polyBuilderCode]?.taker ?? 0)
      : 0;
    if (fi && Number.isFinite(Number(fi.rate))) {
      // Returns the fee-adjusted notional (budget − platformFee − builderFee) at this market/price.
      feeBudgetUsd = adjustBuyAmountForFees(
        budgetUsd, price, budgetUsd, Number(fi.rate), Number(fi.exponent), builderTaker, Number(client.feeSlippage ?? 0),
      );
    } else {
      feeBudgetUsd = budgetUsd * (1 - config.clobBuyFeeBps / 10_000);
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "budgetedBuyOrder: per-market fee fetch failed — reserving flat clobBuyFeeBps");
    feeBudgetUsd = budgetUsd * (1 - config.clobBuyFeeBps / 10_000);
  }

  const desired = Number(event.expected_shares) / 1e6;
  const affordable = price > 0 ? Math.floor((feeBudgetUsd / price) * 100) / 100 : desired; // 0.01 share tick
  const size = Math.min(desired, affordable);
  if (size < desired) {
    logger.info(
      { desired, size, budgetUsd, feeBudgetUsd, rawPrice, tickPrice: price, tick },
      "budgetedBuyOrder: capped size to fit budget+fee at tick-rounded price (avoids 'not enough balance' revert)",
    );
  }
  return { price, size };
}

// "Full fill" tolerance: 0.01 share (1e6-scaled). A fill within DUST_SHARES of the submitted size
// counts as full, so benign tick/fee rounding doesn't force a needless partial.
const DUST_SHARES = 10_000n;

/**
 * CLOB-fee-inclusive `spent` for a market BUY (all 1e6-scaled). The user pays Polymarket's taker fee
 * out of their OWN stake — it is gone, never refunded. budgetedBuyOrder reserved the fee inside
 * `submittedShares`, so a FULL fill of that size means the whole stake was deployed (shares + fee) →
 * spent = betAmount (refund 0). A genuine (book-thin) partial records proportionally → only the
 * unfilled stake refunds (the proportional fee on the filled part stays spent). Callers pass
 * filled > 0 and submittedShares > 0.
 */
export function marketSpentWithFee(betAmount: bigint, filled: bigint, submittedShares: bigint): bigint {
  if (filled >= submittedShares - DUST_SHARES) return betAmount; // full fill (within dust) → whole stake spent
  const spent = (betAmount * filled) / submittedShares;          // proportional (includes the proportional fee)
  return spent > betAmount ? betAmount : spent;
}

/**
 * Absolute CLOB taker fee (1e6-scaled USDC) on a `notionalUsd` trade at `priceFrac`, using the SDK's
 * OWN fee model — NOT a re-implemented formula. `adjustBuyAmountForFees` returns
 * `notional − platformFee − builderFee`, so the fee is simply `notional − adjusted`. Polymarket's
 * taker fee is per-market (`feeInfos[tokenId] = {rate, exponent}`) and price-dependent (∝ p·(1−p));
 * MAKERS pay nothing, so callers apply this only to taker (crossed) fills. Returns 0n when the
 * per-market fee can't be fetched (mock / degraded) — i.e. assume no fee.
 */
async function clobTakerFeeUsd(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  tokenId: string,
  notionalUsd: number,
  priceFrac: number,
): Promise<bigint> {
  if (!client || !(notionalUsd > 0) || !(priceFrac > 0) || !(priceFrac < 1)) return 0n;
  try {
    const { adjustBuyAmountForFees } = await import("@polymarket/clob-client-v2");
    await client.getFeeExponent(tokenId); // ensures feeInfos[tokenId] is cached (getMarket)
    const fi = client.feeInfos?.[tokenId];
    if (!fi || !Number.isFinite(Number(fi.rate))) return 0n;
    const builderTaker = config.polyBuilderCode
      ? Number(client.builderFeeRates?.[config.polyBuilderCode]?.taker ?? 0)
      : 0;
    const adjusted = adjustBuyAmountForFees(
      notionalUsd, priceFrac, notionalUsd, Number(fi.rate), Number(fi.exponent), builderTaker, Number(client.feeSlippage ?? 0),
    );
    const feeUsd = Math.max(0, notionalUsd - Number(adjusted));
    return BigInt(Math.round(feeUsd * 1e6));
  } catch (err) {
    logger.warn({ err: String(err), tokenId }, "clobTakerFeeUsd: per-market fee fetch failed — assuming 0 fee");
    return 0n;
  }
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
      // Hoisted so the post-response actuals computation (L3) can read the budgeted size/price.
      let fokOrder: { price: number; size: number } | null = null;

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
        // Production: shared ClobClient with derived L2 creds (see getOrCreateClobClient).
        const { OrderType, Side } = await import("@polymarket/clob-client-v2");
        const client = await getOrCreateClobClient(wallet);
        if (!client) throw new Error("CLOB client unavailable");
        fokOrder = await budgetedBuyOrder(provider, client, event); // tick-aligned price + budget-capped size
        resp = (await client.createAndPostOrder({
          tokenID: event.position_id,   // capital D — Polymarket UserOrderV2 field
          price: fokOrder.price,
          size: fokOrder.size,
          side: Side.BUY,
          orderType: OrderType.FOK,
          balance: Number(event.bet_amount) / 1e6, // SDK fee-adjusts within the user's stake (exact-fee safety net)
        } as unknown as Parameters<typeof client.createAndPostOrder>[0])) as Record<string, unknown>;
      }

      logger.info({ nullifier: event.nullifier, resp }, "CLOB response");

      // Mock CLOB returns "MATCHED"; real CLOB returns "matched"
      const status = String(resp?.["status"] ?? "").toLowerCase();

      // L3: attest the ACTUAL fill so settlement reconciles to shares truly held. FOK is
      // all-or-nothing at the size we submit, but budgetedBuyOrder may have downsized that size
      // below the committed expected_shares (tick round-up / budget / CLOB-visible balance), so a
      // "matched" FOK can still be a SHORT fill vs the on-chain commitment. attestTerminal then
      // maps a short fill onto a PARTIAL (reconciled via partialFillCredit) instead of FILLED.
      let filled = 0n;
      let spent = 0n;
      if (status === "matched" || status === "filled") {
        if (typeof resp["filledShares"] === "number" && typeof resp["spentAmount"] === "number") {
          // Mock CLOB (incl. the fok_downsize knob) or any response carrying explicit amounts.
          filled = BigInt(Math.floor(resp["filledShares"] as number));
          spent = BigInt(Math.floor(resp["spentAmount"] as number));
        } else if (resp["takingAmount"] !== undefined || resp["makingAmount"] !== undefined) {
          // Real Polymarket CLOB: BUY matched amounts as decimal strings — takingAmount = shares,
          // makingAmount = USDC spent (the CLOB returns these, not size_matched).
          filled = BigInt(Math.round(Number(resp["takingAmount"] ?? 0) * 1e6));
          spent = BigInt(Math.round(Number(resp["makingAmount"] ?? 0) * 1e6));
        } else if (resp["size_matched"] !== undefined) {
          // Real CLOB: matched size in shares; derive spent at the (committed = ceiling) price,
          // rounded up → a pool-safe upper bound on the cost.
          const shares = Number(resp["size_matched"]);
          const px = fokOrder ? fokOrder.price : Number(event.price) / 1e8;
          filled = BigInt(Math.floor(shares * 1e6));
          spent = BigInt(Math.ceil(shares * px * 1e6));
        } else if (fokOrder) {
          // Production match with no size field → FOK filled exactly the size we sent.
          filled = BigInt(Math.round(fokOrder.size * 1e6));
          spent = BigInt(Math.ceil(fokOrder.size * fokOrder.price * 1e6));
        } else {
          // Mock match with no amounts → full fill at the committed values.
          filled = event.expected_shares;
          spent = event.bet_amount;
        }
      }
      // CLOB fee (prod): the fee is the user's cost (gone, not refunded). budgetedBuyOrder reserved it
      // in fokOrder.size, so a full fill of that size deployed the whole stake → spent = bet_amount
      // (refund 0); a short fill records proportionally. (Mirror of submitFAKOrder; mock has no fee.)
      if (fokOrder && filled > 0n) {
        spent = marketSpentWithFee(event.bet_amount, filled, BigInt(Math.round(fokOrder.size * 1e6)));
      }
      logger.info(
        { nullifier: event.nullifier, status, filled: filled.toString(), spent: spent.toString() },
        "FOK order terminal — attesting actual fill",
      );
      await attestTerminal(
        wallet,
        { nullifier: event.nullifier, expected_shares: event.expected_shares, bet_amount: event.bet_amount },
        status,
        filled,
        spent,
      );
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

      // Durable "an order is being POSTed" marker, written BEFORE the CLOB POST. Its ABSENCE proves
      // no order was ever placed (so /cancel-bet may safely attest FAILED); its PRESENCE forces
      // cancel-bet to reconcile the true fill instead of blind-FAILED (which would reclaim a position
      // the pool actually bought). Survives a process restart — closes the restart-mid-submit race.
      markMarketSubmitting(event.nullifier, event.market_id);

      let resp: Record<string, unknown>;
      // Prod only: the fee-reserved size we submitted (1e6-scaled shares), used to report `spent`
      // INCLUDING the CLOB fee so a full fill records the whole stake (fee not refunded). 0 = mock.
      let submittedShares1e6 = 0n;
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
        const bo = await budgetedBuyOrder(provider, client, event); // tick-aligned price + fee-reserved size
        submittedShares1e6 = BigInt(Math.round(bo.size * 1e6));
        resp = (await client.createAndPostOrder({
          tokenID: event.position_id,
          price: bo.price,
          size: bo.size,
          side: Side.BUY,
          orderType: OrderType.FAK,
          balance: Number(event.bet_amount) / 1e6, // SDK fee-adjusts within the user's stake (exact-fee safety net)
        } as unknown as Parameters<typeof client.createAndPostOrder>[0])) as Record<string, unknown>;
      }

      logger.info({ nullifier: event.nullifier, resp }, "FAK CLOB response");

      // Persist the CLOB order id so a later /cancel-bet (e.g. after a process restart that lost the
      // in-memory in-flight set, before this path attested) can reconcile the TRUE fill via getOrder.
      const orderId = String(resp?.["orderID"] ?? resp?.["orderId"] ?? resp?.["id"] ?? "");
      if (orderId) setMarketOrderId(event.nullifier, orderId);

      const status = String(resp?.["status"] ?? "").toLowerCase();
      let filledShares = 0n;
      let spentAmount = 0n;
      if (typeof resp["filledShares"] === "number" && typeof resp["spentAmount"] === "number") {
        // Mock CLOB: 1e6-scaled integers.
        filledShares = BigInt(Math.floor(resp["filledShares"] as number));
        spentAmount = BigInt(Math.floor(resp["spentAmount"] as number));
      } else if (resp["takingAmount"] !== undefined || resp["makingAmount"] !== undefined) {
        // Real Polymarket CLOB: matched amounts are DECIMAL STRINGS. For a BUY the order gives USDC
        // and takes shares → takingAmount = shares received, makingAmount = USDC spent. The CLOB does
        // NOT return size_matched here; assuming it did made a real partial fill parse to 0 → FAILED
        // → false full reclaim → pool loss. THIS IS THE FIX.
        filledShares = BigInt(Math.round(Number(resp["takingAmount"] ?? 0) * 1e6));
        spentAmount = BigInt(Math.round(Number(resp["makingAmount"] ?? 0) * 1e6));
      } else if (resp["size_matched"] !== undefined) {
        const shares = Number(resp["size_matched"]);
        filledShares = BigInt(Math.floor(shares * 1e6));
        spentAmount = (filledShares * event.price) / 100_000_000n;
      }

      // CLOB fee (prod): the user pays Polymarket's taker fee out of their bet_amount and it is GONE
      // (never refunded). budgetedBuyOrder reserved it in the size, so a FULL fill of that size means
      // the whole stake was deployed (shares + fee) → record spent = bet_amount (refund 0); a genuine
      // partial records proportionally → refunds only the unfilled stake. (makingAmount alone omits the
      // fee and would wrongly refund it.) The mock has no fee → keep its reported spent.
      if (submittedShares1e6 > 0n && filledShares > 0n) {
        spentAmount = marketSpentWithFee(event.bet_amount, filledShares, submittedShares1e6);
      }

      // Fail-safe: NEVER attest FAILED for an order whose fill we couldn't read but that was NOT an
      // explicit miss — a real fill misread as 0 lets the user reclaim a position the pool paid for.
      // If inconclusive, leave it un-attested (stuck pending → manual/reconcile) rather than risk a
      // false reclaim. An explicit unmatched/killed (genuine zero fill) still flows to FAILED below.
      const errText = String(resp["errorMsg"] ?? resp["error"] ?? "");
      // An explicit CLOB REJECTION (HTTP 4xx, or a clear validation error like "min size: $1",
      // "not enough balance", "invalid amount") means the order was NEVER placed — so a zero fill is
      // certain, NOT a misread. Treat it as a definitive miss so it flows to attestTerminal → FAILED
      // (reclaimable) instead of stranding the bet "indeterminate / needs reconcile" forever.
      const respStatusNum = Number(resp["status"]);
      const rejected =
        (Number.isFinite(respStatusNum) && respStatusNum >= 400) ||
        /invalid amount|min size|not enough|insufficient|too small|rejected|bad request/i.test(errText);
      if (rejected) {
        logger.warn({ nullifier: event.nullifier, resp }, "FAK order rejected by CLOB (explicit) — attesting FAILED so the stake is reclaimable");
      }
      const explicitMiss =
        status === "unmatched" || status === "killed" || status === "cancelled" ||
        /not[_ ]?filled/i.test(errText) || rejected;
      if (filledShares === 0n && !explicitMiss && !isMock) {
        logger.error({ nullifier: event.nullifier, resp }, "FAK fill indeterminate and not an explicit miss — NOT attesting (no false reclaim); needs reconcile");
        return;
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

/**
 * /cancel-bet reconcile for a MARKET (FAK) order that was submitted to the CLOB but has no terminal
 * attestation yet (e.g. submitFAKOrder crashed mid-flight, or a restart lost the in-memory in-flight
 * set). Determines the TRUE fill from the CLOB and attests the real outcome — it NEVER blind-attests
 * FAILED, so a filled position can't be wrongly reclaimed (no double-spend / pool drain).
 *
 * A FAK BUY is the TAKER, so getTrades-by-maker (used for resting orders) doesn't see it — the
 * reliable source is getOrder(orderId).size_matched. If the fill can't be verified (no orderId, CLOB
 * unavailable, or the order isn't in a terminal queryable state) we LEAVE THE BET PENDING ("processing")
 * rather than risk a false reclaim; the WS/deep-sweep or a later retry finalizes it.
 *
 * Returns "finalized" once a terminal attestation exists, else "processing".
 */
export async function reconcileMarketSubmission(
  wallet: ethers.Wallet,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  clobClient: any,
  provider: ethers.JsonRpcProvider,
  nullifier: string,
  sub: MarketSubmission,
): Promise<"finalized" | "processing"> {
  // submitFAKOrder usually attests synchronously — short-circuit if a terminal outcome already exists.
  if (getAttestation(nullifier)) return "finalized";
  if (!sub.orderId) {
    // No orderId ⇒ the FAK POST never placed an order on the book (setMarketOrderId only runs after the
    // CLOB returns an id; a FAK never rests, so it can't fill later). The original code left this
    // "processing" FOREVER → the stake was unreclaimable (the user's stuck-Reclaim bug). Once the
    // submission window has CLEARLY passed (any real submit finished long ago), it's a definitive
    // zero-fill → attest FAILED so the stake is reclaimable. Before the window, the synchronous submit
    // may still be completing → stay pending.
    const ageSec = Math.floor(Date.now() / 1000) - sub.submittedAt;
    if (ageSec > STALE_SUBMISSION_SEC) {
      logger.warn({ nullifier, ageSec }, "cancel-bet: FAK never placed (no orderId) and stale — attesting FAILED (reclaimable)");
      await attestFailedFor(wallet, nullifier);
      return "finalized";
    }
    logger.warn({ nullifier, ageSec }, "cancel-bet: FAK has no orderId yet but is within the submit window — leaving pending");
    return "processing";
  }
  if (!clobClient) {
    // An order WAS placed (orderId present) but we have no client to read its fill — never risk a
    // false reclaim of a position that may have filled.
    logger.warn({ nullifier, orderId: sub.orderId }, "cancel-bet: clob client unavailable — leaving pending (no false reclaim)");
    return "processing";
  }
  // Committed bounds for the FILLED-vs-PARTIAL classification (attestTerminal needs them).
  let expected_shares = 0n;
  let bet_amount = 0n;
  try {
    const vault = new ethers.Contract(config.vaultContractAddress, BET_RECORDS_ABI, provider);
    const rec = await vault.betRecords(nullifier);
    expected_shares = BigInt(rec[3]);
    bet_amount = BigInt(rec[4]);
  } catch (err) {
    logger.warn({ err: String(err), nullifier }, "cancel-bet: betRecords read failed — cannot classify fill; leaving pending");
    return "processing";
  }
  try {
    const od = await clobClient.getOrder(sub.orderId);
    const st = String((od && od.status) || "").toUpperCase();
    // Only act on a TERMINAL order state — a still-live/delayed FAK could still be matching, and a
    // zero fill is only DEFINITE once the order is off the book.
    if (od && st && st !== "LIVE" && st !== "DELAYED" && st !== "OPEN") {
      const matched = Number((od && od.size_matched) || 0);
      const priceFrac = Number((od && od.price) || 0);
      const filled = BigInt(Math.round(matched * 1e6));
      // spent omits the CLOB taker fee (the synchronous submitFAKOrder path accounts for it exactly);
      // on this rare reconcile backstop a PARTIAL may over-refund by the fee on the filled portion —
      // bounded and pool-safe, never a false full reclaim. A full fill maps to FILLED (amountB ignored).
      const spent = BigInt(Math.round(matched * priceFrac * 1e6));
      const status = matched <= 0 ? "unmatched" : "matched";
      await attestTerminal(wallet, { nullifier, expected_shares, bet_amount }, status, filled, spent);
      logger.info({ nullifier, orderStatus: st, matched }, "cancel-bet: reconciled market order from CLOB getOrder");
      return getAttestation(nullifier) ? "finalized" : "processing";
    }
    logger.warn({ nullifier, orderStatus: st }, "cancel-bet: market order not terminal/queryable — leaving pending (no false reclaim)");
    return "processing";
  } catch (err) {
    logger.warn({ err: String(err), nullifier, orderId: sub.orderId }, "cancel-bet: getOrder failed — leaving pending (no false reclaim)");
    return "processing";
  }
}

/**
 * Authoritative confirmation that a FOK SELL actually executed — for the case where the
 * synchronous createAndPostOrder response is AMBIGUOUS (the real CLOB can return "delayed"/"live"
 * with the match landing async, instead of an immediate "matched"). A FOK resolves quickly, so we
 * poll the authenticated CLOB for a short window (well within the frontend's 60s close poll):
 *   - getOrder(orderID): terminal MATCHED/FILLED with size_matched ≥ size → filled; an explicit
 *     CANCELED/KILLED/UNMATCHED → not filled.
 *   - trade history: our order as the TAKER (a market SELL crosses the book as a taker) or as a
 *     maker; sum the matched size.
 * Returns true once the full size is confirmed filled; false on timeout (caller then leaves the
 * position open — no SOLD attestation). Best-effort: query errors are retried until the deadline.
 */
async function confirmSellFilled(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  orderID: string,
  conditionId: string,
  sizeShares1e6: bigint,
): Promise<boolean> {
  const target = Number(sizeShares1e6) / 1e6;
  const tol = target * 0.999; // tolerate sub-unit rounding
  const oid = orderID.toLowerCase();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if (orderID) {
        const od = await client.getOrder(orderID).catch(() => null);
        const st = String(od?.status ?? "").toUpperCase();
        if (od && (st === "MATCHED" || st === "FILLED") && Number(od?.size_matched ?? 0) >= tol) return true;
        if (od && (st === "CANCELED" || st === "CANCELLED" || st === "KILLED" || st === "UNMATCHED")) return false;
      }
      if (conditionId) {
        const trades = await client.getTrades({ market: conditionId }).catch(() => null);
        if (Array.isArray(trades)) {
          let shares = 0;
          for (const t of trades) {
            if (String(t?.taker_order_id ?? "").toLowerCase() === oid) shares += Number(t?.size ?? 0);
            for (const mo of (t?.maker_orders ?? [])) {
              if (String(mo?.order_id ?? "").toLowerCase() === oid) shares += Number(mo?.matched_amount ?? 0);
            }
          }
          if (shares >= tol) return true;
        }
      }
    } catch {
      /* transient — keep polling */
    }
    await new Promise((r) => setTimeout(r, 2_500));
  }
  return false;
}

// FC-1: resolve the REAL CLOB tokenId + conditionId for a position-close SELL. The close request
// carries the SYNTHETIC on-chain position_id; the CLOB needs the real tokenId (and the conditionId
// for ws subscribe / trade-history fill confirmation), resolved from the bet's on-chain
// (market_id, outcome_side) via the market registry — exactly as the BUY path does. Falls back to
// the request's position_id (mock / unresolved).
async function resolveCloseToken(
  req: CloseRequest,
  provider: ethers.JsonRpcProvider,
): Promise<{ tokenId: string; conditionId: string }> {
  let tokenId = req.position_id;
  let conditionId = "";
  try {
    const vault = new ethers.Contract(config.vaultContractAddress, BET_RECORDS_ABI, provider);
    const rec = await vault.betRecords(req.nullifier_of_bet);
    const resolved = resolveToken(String(rec.market_id ?? rec[0]), Number(rec.outcome_side ?? rec[5]));
    if (resolved?.tokenId) {
      tokenId = resolved.tokenId;
      conditionId = resolved.conditionId;
    } else {
      logger.warn({ nullifier_of_bet: req.nullifier_of_bet }, "close: no market-registry entry — using request position_id (SELL may not match)");
    }
  } catch (err) {
    logger.warn({ err: String(err), nullifier_of_bet: req.nullifier_of_bet }, "close: real-tokenId resolve failed — using request position_id");
  }
  return { tokenId, conditionId };
}

// FC-1 (Market close): submit a FAK (fill-and-kill) market SELL to close a position now. Unlike the
// old FOK (all-or-nothing) it may PARTIALLY fill; attestTerminal(side:SELL) signs SOLD for the
// ACTUAL filled size (the Vault credits the proceeds and leaves the unsold remainder to settle).
// A zero fill produces NO attestation — the position simply stays open.
/** Best bid (1e6-scaled) for a token from the CLOB order book — the price a SELL can cross/fill at
 * right now. Mirrors how the market BUY prices to cross the asks. Returns null on any failure (caller
 * falls back to the passed floor). */
async function fetchBestBidMicro(tokenId: string): Promise<bigint | null> {
  try {
    const clobHost = process.env.POLY_API_URL ?? "https://clob.polymarket.com";
    const res = await fetch(`${clobHost}/book?token_id=${encodeURIComponent(tokenId)}`);
    if (!res.ok) return null;
    const book = (await res.json()) as { bids?: Array<{ price?: string; size?: string }> };
    const best = (book.bids ?? []).reduce((m, b) => Math.max(m, Number(b?.price ?? 0) || 0), 0);
    return best > 0 ? BigInt(Math.round(best * 1e6)) : null;
  } catch {
    return null;
  }
}

export async function submitMarketSellOrder(
  req: CloseRequest,
  wallet: ethers.Wallet,
  provider: ethers.JsonRpcProvider
): Promise<void> {
  if (isHalted()) {
    logger.warn({ nullifier_of_bet: req.nullifier_of_bet }, "Circuit breaker is active — skipping close");
    return;
  }

  // Idempotency / no double-sell (single-write SOLD): a prior close already executed + attested. The
  // deposit wallet's CTF shares are POOLED across depositors, so re-selling would dump shares owed to
  // others. (v1 = one close order per bet.)
  if (getAttestation(req.nullifier_of_bet, ReportType.SOLD)) {
    logger.info({ nullifier_of_bet: req.nullifier_of_bet }, "close: SOLD attestation already exists — skipping duplicate SELL");
    return;
  }

  // Submit under the rate limiter; confirm an ambiguous fill OUTSIDE it (the confirm can poll ~20s
  // and must not hold the global order-submission limiter).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type SellCtx = { filledShares: bigint; ambiguous: boolean; client: any; orderID: string; conditionId: string; tokenId: string; status: string; sellPriceMicro: bigint };
  const ctx = await limiter.schedule<SellCtx | null>(async () => {
    try {
      const clobHost = process.env.POLY_API_URL ?? "https://clob.polymarket.com";
      const isMock = clobHost.includes("localhost") || clobHost.includes("127.0.0.1");

      if (isMock) {
        const res = await fetch(`${clobHost}/order`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            order: { tokenId: req.position_id, price: microToDecimal(req.limit_price), makerAmount: microToDecimal(req.sold_shares), side: "SELL" },
            orderType: "FAK",
          }),
        });
        if (res.status === 403) { checkResponse(403); return null; }
        const resp = (await res.json()) as Record<string, unknown>;
        logger.info({ nullifier_of_bet: req.nullifier_of_bet, resp }, "CLOB market-SELL response (mock)");
        const filledShares = typeof resp["filledShares"] === "number" ? BigInt(Math.floor(resp["filledShares"] as number)) : 0n;
        return { filledShares, ambiguous: false, client: null, orderID: "", conditionId: "", tokenId: req.position_id, status: String(resp["status"] ?? ""), sellPriceMicro: req.limit_price };
      }

      const { OrderType, Side } = await import("@polymarket/clob-client-v2");
      const client = await getOrCreateClobClient(wallet);
      if (!client) throw new Error("CLOB client unavailable");
      const { tokenId, conditionId } = await resolveCloseToken(req, provider);
      // A MARKET (FAK) close must price at the current best BID to actually cross the book — mirroring
      // the market BUY (budgetedBuyOrder), which prices to cross the asks. A fixed floor (e.g. 1¢)
      // never fills a sub-1¢ market (the cause of the zero-fill close). req.limit_price is a protective
      // FLOOR: never sell below it. Credit stays at the executed price (pool-safe: fill ≥ price).
      const bestBid = await fetchBestBidMicro(tokenId);
      const sellPriceMicro = bestBid && bestBid >= req.limit_price ? bestBid : req.limit_price;
      const resp = (await client.createAndPostOrder({
        tokenID: tokenId,
        price: Number(sellPriceMicro) / 1e6,
        size: Number(req.sold_shares) / 1e6,
        side: Side.SELL,
        orderType: OrderType.FAK,
      } as unknown as Parameters<typeof client.createAndPostOrder>[0])) as Record<string, unknown>;
      logger.info({ nullifier_of_bet: req.nullifier_of_bet, bestBid: bestBid?.toString(), sellPriceMicro: sellPriceMicro.toString(), resp }, "CLOB market-SELL response");

      const status = String(resp?.["status"] ?? "").toLowerCase();
      const errMsg = String(resp?.["errorMsg"] ?? resp?.["error"] ?? "");
      const orderID = String(resp?.["orderID"] ?? resp?.["orderId"] ?? resp?.["id"] ?? "");
      const killed = status === "unmatched" || status === "killed" || status === "cancelled" || /NOT_FILLED/i.test(errMsg);
      if (resp?.["makingAmount"] !== undefined || resp?.["takingAmount"] !== undefined) {
        // Real Polymarket CLOB: matched amounts as decimal strings. For a SELL the order gives shares
        // and takes USDC → makingAmount = shares SOLD (proceeds are computed below at sellPriceMicro,
        // the executed best-bid price, pool-safe).
        return { filledShares: BigInt(Math.round(Number(resp["makingAmount"] ?? 0) * 1e6)), ambiguous: false, client, orderID, conditionId, tokenId, status, sellPriceMicro };
      }
      if (resp?.["size_matched"] !== undefined) {
        return { filledShares: BigInt(Math.floor(Number(resp["size_matched"]) * 1e6)), ambiguous: false, client, orderID, conditionId, tokenId, status, sellPriceMicro };
      }
      // No matched size in the response and not explicitly killed → ambiguous; confirm OUTSIDE the limiter.
      return { filledShares: 0n, ambiguous: !killed, client, orderID, conditionId, tokenId, status, sellPriceMicro };
    } catch (err: unknown) {
      const e = err as { status?: number; response?: { status?: number } };
      const httpStatus = e?.status ?? e?.response?.status;
      if (httpStatus !== undefined) checkResponse(httpStatus);
      logger.error({ err, nullifier_of_bet: req.nullifier_of_bet }, "Close (market SELL) submission failed");
      return null;
    }
  });

  if (!ctx) return;

  let filledShares = ctx.filledShares;
  // Ambiguous response (FAK matched async / "delayed"): confirm the TRUE fill before giving up so a
  // SELL that actually executed isn't dropped (close-failed-but-sold). confirmSellFilled checks a
  // FULL fill; a confirmed full fill means the whole requested size sold.
  if (filledShares === 0n && ctx.ambiguous && ctx.client && ctx.orderID) {
    logger.info({ nullifier_of_bet: req.nullifier_of_bet, orderID: ctx.orderID }, "market SELL ambiguous — confirming fill via getOrder/getTrades");
    if (await confirmSellFilled(ctx.client, ctx.orderID, ctx.conditionId, req.sold_shares)) filledShares = req.sold_shares;
  }

  // Proceeds at the (conservative) limit price — a SELL fills at ≥ its limit, so crediting at the
  // limit never over-credits the pool — NET of the CLOB taker fee. A market SELL is a taker, and
  // Polymarket deducts the fee from the proceeds, so the user bears it and the pool isn't short.
  // attestTerminal(side:SELL) signs SOLD for the actual fill; a zero fill → no attestation.
  const grossProceeds = (filledShares * ctx.sellPriceMicro) / 1_000_000n;
  const sellPriceFrac = Number(ctx.sellPriceMicro) / 1e6;
  const sellFee = await clobTakerFeeUsd(ctx.client, ctx.tokenId, (Number(filledShares) / 1e6) * sellPriceFrac, sellPriceFrac);
  const proceeds = grossProceeds > sellFee ? grossProceeds - sellFee : 0n;
  await attestTerminal(
    wallet,
    { nullifier: req.nullifier_of_bet, expected_shares: req.sold_shares, bet_amount: 0n, side: "SELL" },
    ctx.status,
    filledShares,
    proceeds,
  );
}

// FC-1 (Limit close): submit a RESTING GTC/GTD limit SELL to close a position at the user's price.
// It rests on the book; the websocket fill tracker (side: SELL) drives the eventual SOLD attestation
// for the ACTUAL fill (partial fills supported). Differs from the BUY resting path: NO JIT funding
// (a SELL needs no buying power — the pooled CTF shares already exist) and NO FAILED-on-reject
// (a failed CLOSE must leave the bet untouched, never reclaimable).
export async function submitLimitSellOrder(
  req: CloseRequest,
  params: LimitOrderParams,
  wallet: ethers.Wallet,
  provider: ethers.JsonRpcProvider
): Promise<void> {
  if (isHalted()) {
    logger.warn({ nullifier_of_bet: req.nullifier_of_bet }, "Circuit breaker is active — skipping limit close");
    return;
  }
  if (getAttestation(req.nullifier_of_bet, ReportType.SOLD)) {
    logger.info({ nullifier_of_bet: req.nullifier_of_bet }, "limit close: SOLD attestation already exists — skipping duplicate SELL");
    return;
  }
  if (isOrderTracked(req.nullifier_of_bet)) {
    logger.info({ nullifier_of_bet: req.nullifier_of_bet }, "limit close: a resting order is already tracked for this bet — skipping");
    return;
  }

  await limiter.schedule(async () => {
    try {
      const clobHost = process.env.POLY_API_URL ?? "https://clob.polymarket.com";
      const isMock = clobHost.includes("localhost") || clobHost.includes("127.0.0.1");
      logger.info({ clobHost, isMock, orderType: params.orderType }, "submitting limit SELL (close)");

      // GTD effective lifetime: now + 60s security threshold + N (Polymarket convention).
      const expiration = params.orderType === "GTD" ? Math.floor(Date.now() / 1000) + 60 + params.expiration : 0;

      let resp: Record<string, unknown>;
      let tokenId = req.position_id;
      let conditionId = req.position_id;
      if (isMock) {
        const res = await fetch(`${clobHost}/order`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            order: { tokenId: req.position_id, price: microToDecimal(req.limit_price), makerAmount: microToDecimal(req.sold_shares), side: "SELL" },
            orderType: params.orderType,
            expiration,
          }),
        });
        if (res.status === 403) { checkResponse(403); return; }
        resp = (await res.json()) as Record<string, unknown>;
      } else {
        const { OrderType, Side } = await import("@polymarket/clob-client-v2");
        const client = await getOrCreateClobClient(wallet);
        if (!client) { logger.error("limit SELL: clob client unavailable"); return; }
        const resolved = await resolveCloseToken(req, provider);
        tokenId = resolved.tokenId;
        conditionId = resolved.conditionId;
        resp = (await client.createAndPostOrder({
          tokenID: tokenId,
          price: Number(req.limit_price) / 1e6,
          size: Number(req.sold_shares) / 1e6,
          side: Side.SELL,
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
      logger.info({ nullifier_of_bet: req.nullifier_of_bet, orderID, initialStatus, resp }, "limit SELL CLOB response");

      if (!orderID) {
        // Rejected: a failed CLOSE must leave the bet UNTOUCHED — do NOT attest FAILED (that path
        // reclaims the whole bet stake; the user still holds the position). The frontend close poll
        // times out and the position stays open.
        logger.warn({ nullifier_of_bet: req.nullifier_of_bet, initialStatus, resp }, "limit SELL returned no orderID (rejected) — leaving position open");
        return;
      }

      // (b) If this limit SELL CROSSED on submission it took liquidity (taker) → a fee applies to the
      // crossed shares (resp.makingAmount = shares sold immediately); the resting remainder is a MAKER
      // (no fee). Capture the crossed-portion fee so the tracker SUBTRACTS it from proceeds at terminal
      // (the user bears the SELL fee). Prod only (the mock charges no fee).
      let takerFeeUsd = 0n;
      if (!isMock) {
        const crossedShares = Number(resp["makingAmount"] ?? 0);
        if (crossedShares > 0) {
          const priceFrac = Number(req.limit_price) / 1e6;
          const c = await getOrCreateClobClient(wallet);
          takerFeeUsd = await clobTakerFeeUsd(c, tokenId, crossedShares * priceFrac, priceFrac);
        }
      }

      // Hand off to the async fill tracker (side: SELL). On terminal it attests SOLD for the actual
      // fill; a zero-fill terminal produces no attestation (position unchanged).
      trackOrder({
        nullifier: req.nullifier_of_bet,
        orderID,
        conditionId,
        tokenId,
        expected_shares: req.sold_shares, // the target sell size (attestTerminal's DUST snap uses it)
        bet_amount: 0n,                   // unused for SELL
        price: 0n,                        // unused for SELL (proceeds use sellLimitPrice)
        orderType: params.orderType,
        expiration,
        side: "SELL",
        sellLimitPrice: req.limit_price,
        takerFeeUsd,
      });
    } catch (err: unknown) {
      const e = err as { status?: number; response?: { status?: number } };
      const httpStatus = e?.status ?? e?.response?.status;
      if (httpStatus !== undefined) checkResponse(httpStatus);
      logger.error({ err, nullifier_of_bet: req.nullifier_of_bet }, "limit SELL (close) submission failed");
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
        // Fee-aware sizing at the user's (tick-rounded) limit price — mirrors the market BUY. A limit
        // that CROSSES on submission is a taker, so order_amount + taker_fee must fit the stake; with
        // the full expected_shares the CLOB rejected "not enough balance to cover the fee estimate"
        // and the bet wrongly FAILED. budgetedBuyOrder reserves the per-market fee (and floors to the
        // CLOB-visible balance), buying slightly fewer shares — the user bears the fee from their stake
        // per the fee model; expected_shares stays the committed cap and settlement/partial-credit
        // reconciles the difference. (Frontend already tick-rounds the price, so the ceil is a no-op.)
        const bo = await budgetedBuyOrder(provider, client, event);
        logger.info(
          { nullifier: event.nullifier, price: bo.price, size: bo.size, expectedShares: Number(event.expected_shares) / 1e6 },
          "limit order sized (fee-aware)",
        );
        resp = (await client.createAndPostOrder({
          tokenID: event.position_id,
          price: bo.price,
          size: bo.size,
          side: Side.BUY,
          orderType: params.orderType === "GTD" ? OrderType.GTD : OrderType.GTC,
          expiration,
          // The SDK deducts the taker fee from the notional iff this limit crosses (taker); a resting
          // maker fill keeps the full size. Without this the CLOB rejects a crossing limit ("not
          // enough balance to cover the fee estimate") — the mainnet bug-2 symptom.
          balance: Number(event.bet_amount) / 1e6,
        } as unknown as Parameters<typeof client.createAndPostOrder>[0])) as Record<string, unknown>;
      }

      const orderID =
        (typeof resp["orderID"] === "string" && (resp["orderID"] as string)) ||
        (typeof resp["orderId"] === "string" && (resp["orderId"] as string)) ||
        (typeof resp["id"] === "string" && (resp["id"] as string)) ||
        undefined;
      const initialStatus = String(resp["status"] ?? "").toLowerCase();
      // Log the full resp (incl. resp.error on a 400) so rejections are diagnosable, matching
      // the FOK/FAK paths — previously only the status code was logged.
      logger.info({ nullifier: event.nullifier, orderID, initialStatus, resp }, "limit order CLOB response");

      // Resting on the book → record a non-binding UI signal only. FC-9: RESTING is
      // no longer on-chain, so nothing is signed or sent here.
      if (initialStatus === "live") {
        markResting(event.nullifier);
        logger.info({ nullifier: event.nullifier }, "limit order live — recorded RESTING (non-binding UI signal)");
      }

      if (!orderID) {
        // CRITICAL fund-safety: only a GENUINE rejection may be attested FAILED. If the CLOB accepted
        // the order — it is LIVE (resting), matched, or delayed — a missing orderID is just a
        // response-shape mismatch, NOT a rejection. NEVER attest FAILED for a still-live order: it can
        // fill at any moment, and FAILED unlocks betCancellationCredit, so the user could reclaim the
        // stake WHILE the order is still fillable → they get the refund AND the fill = a double-credit
        // that drains the pool. A GTC has no expiry, so it must stay reclaim-via-cancel only, never
        // auto-FAILED while live. Leave a live order resting (cancel/reconcile by nullifier recovers
        // it); fail only when it is clearly NOT on the book.
        const accepted =
          initialStatus === "live" || initialStatus === "matched" || initialStatus === "delayed";
        if (accepted) {
          logger.warn(
            { nullifier: event.nullifier, initialStatus, resp },
            "limit order accepted (live/matched) but orderID not parsed — leaving it RESTING, NOT failing",
          );
          return;
        }
        // No orderID AND not accepted → genuine rejection (e.g. 400). Attest FAILED so the depositor
        // can reclaim via betCancellationCredit instead of the bet sitting ACTIVE forever.
        logger.warn(
          { nullifier: event.nullifier, initialStatus, resp },
          "limit order returned no orderID and was not accepted (rejected) — attesting FAILED (reclaimable)",
        );
        await attest(wallet, event.nullifier, ReportType.FAILED, 0n, 0n);
        return;
      }

      // (a) If this limit CROSSED on submission it took liquidity (taker) → a fee applies to the
      // crossed shares (resp.takingAmount); the resting remainder fills as a MAKER (no fee). Capture
      // the crossed-portion fee so the tracker adds it to `spent` at terminal (not refunded). A pure
      // resting order has no immediate fill → 0. Prod only (the mock charges no fee).
      let takerFeeUsd = 0n;
      if (!isMock) {
        const crossedShares = Number(resp["takingAmount"] ?? 0);
        if (crossedShares > 0) {
          const priceFrac = Number(event.price) / 1e8;
          const c = await getOrCreateClobClient(wallet);
          takerFeeUsd = await clobTakerFeeUsd(c, event.position_id, crossedShares * priceFrac, priceFrac);
        }
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
        side: "BUY",
        sellLimitPrice: 0n,
        takerFeeUsd,
      });
    } catch (err: unknown) {
      const e = err as { status?: number; response?: { status?: number } };
      const httpStatus = e?.status ?? e?.response?.status;
      if (httpStatus !== undefined) checkResponse(httpStatus);
      logger.error({ err, nullifier: event.nullifier }, "Limit order submission failed");
    }
  });
}
