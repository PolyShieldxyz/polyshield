/**
 * L1 — proof-time price snapping (ceiling pricing for market BUYs).
 *
 * The bet_auth circuit commits `price` (1e8-scaled) and derives `expected_shares` from it. To keep
 * the committed price aligned with what the CLOB will actually execute, the frontend snaps the
 * price to the market tick BEFORE proving (mirroring the signing layer's budgetedBuyOrder). For a
 * market BUY we additionally derive an execution CEILING and snap UP, so the committed price is a
 * true upper bound: the real fill is at-or-better, the committed `expected_shares` is a
 * guaranteed-achievable MINIMUM, the pool is never over-credited even before L3 reconciliation
 * fires, and any price-improvement surplus accrues to the pool (FC-4 Q4).
 *
 * The ceiling is computed by WALKING THE BOOK (`marketBuyCeilingFromBook`): we accumulate resting
 * ask liquidity across price levels until it covers the order's notional, and take the worst price
 * touched as the clearing price (+ a small slippage pad as a snapshot-race buffer). This is strictly
 * tighter/safer than the old flat best-ask × (1 + pad): for an order large enough to eat past the
 * top level in a thin book, a flat pad under-estimates the true ceiling and over-states
 * `expected_shares` → pool over-credit. `marketBuyCeiling` (flat pad) is retained as the
 * empty-ladder fallback.
 */

// Slippage pad applied to the best ask for a market BUY, in basis points. Configurable via env
// (NEXT_PUBLIC_* is inlined at build time). Default 200 bps = 2% — comfortably above Polymarket's
// taker fee (~0.77% observed) so the committed expected_shares (a guaranteed MINIMUM) usually still
// sits at-or-below the fee-reduced actual fill → the order lands as a clean FILLED instead of a
// needless L3 partial-credit normalization. Keep it ≥ the live CLOB fee (see signing-layer
// clobBuyFeeBps); only deep multi-level sweeps then normalize.
export const MARKET_SLIPPAGE_BPS =
  Number(process.env.NEXT_PUBLIC_MARKET_SLIPPAGE_BPS ?? '200') || 200

const DEFAULT_TICK = 0.001 // Polymarket's finest tick; used when the real tick is unknown.

function safeTick(tick: number | undefined): number {
  return typeof tick === 'number' && Number.isFinite(tick) && tick > 0 ? tick : DEFAULT_TICK
}

/** Clean fp noise to 6dp (prices are ≤ 1.0 with ≤ 0.001 ticks). */
function clean(p: number): number {
  return Number(p.toFixed(6))
}

/** Round `price` UP to the nearest `tick` (matches budgetedBuyOrder's ceil-to-tick). */
export function ceilToTick(price: number, tick?: number): number {
  const t = safeTick(tick)
  return clean(Math.ceil(price / t - 1e-9) * t)
}

/** Round `price` to the NEAREST `tick` (used for a resting limit price). */
export function roundToTick(price: number, tick?: number): number {
  const t = safeTick(tick)
  return clean(Math.round(price / t) * t)
}

/**
 * Market-BUY execution ceiling: best ask × (1 + slippage), snapped UP to the tick and clamped to
 * the valid (tick, 1 − tick) price band. The flat-pad fallback used when the order book is empty;
 * prefer `marketBuyCeilingFromBook` when depth is available.
 */
export function marketBuyCeiling(ask: number, tick?: number, slippageBps = MARKET_SLIPPAGE_BPS): number {
  const t = safeTick(tick)
  const padded = (Number.isFinite(ask) && ask > 0 ? ask : 0.5) * (1 + slippageBps / 10_000)
  const snapped = ceilToTick(padded, t)
  return clean(Math.min(1 - t, Math.max(t, snapped)))
}

/** A single resting order-book level: `size` shares offered at `price` (both in human units). */
export interface BookLevel {
  price: number
  size: number
}

/**
 * Market-BUY execution ceiling computed by WALKING THE BOOK.
 *
 * `levels` is the executable ask ladder for the chosen side (ascending by price; for the NO side
 * the caller passes the complemented YES bids). We accumulate cost = Σ price×size across levels
 * until it covers `notionalUsd` (the order's USD stake), and take the worst price touched as the
 * clearing price. If the ladder is too thin to cover the notional, the deepest level's price is the
 * clearing price (the signing layer's L2 budget cap then sizes the actual order down). The ceiling
 * is `clearing × (1 + slippage)`, snapped UP to the tick and clamped to (tick, 1 − tick).
 *
 * Because ceiling ≥ every price actually swept, `expected_shares = notional / ceiling` is a true
 * lower bound on the shares the fill yields — the pool is never over-credited (FC-4 Q4). Falls back
 * to the flat-pad `marketBuyCeiling(fallbackAsk)` when the ladder is empty/unusable.
 */
export function marketBuyCeilingFromBook(
  levels: BookLevel[],
  notionalUsd: number,
  tick?: number,
  fallbackAsk?: number,
  slippageBps = MARKET_SLIPPAGE_BPS,
): number {
  const t = safeTick(tick)
  const usable = (levels ?? [])
    .filter((l) => Number.isFinite(l.price) && l.price > 0 && Number.isFinite(l.size) && l.size > 0)
    .sort((a, b) => a.price - b.price)

  if (usable.length === 0) {
    return marketBuyCeiling(fallbackAsk ?? 0.5, t, slippageBps)
  }

  // Walk ascending, accumulating cost until it covers the notional; the worst level touched is the
  // clearing price. A non-positive/NaN notional degenerates to top-of-book (clearing = first level).
  let clearing = usable[0].price
  if (Number.isFinite(notionalUsd) && notionalUsd > 0) {
    let cost = 0
    for (const level of usable) {
      clearing = level.price
      cost += level.price * level.size
      if (cost >= notionalUsd) break
    }
    // Loop exhausted without covering the notional → clearing already holds the deepest level price.
  }

  const padded = clearing * (1 + slippageBps / 10_000)
  const snapped = ceilToTick(padded, t)
  return clean(Math.min(1 - t, Math.max(t, snapped)))
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared order preview (C4) — ONE source of truth for the share/fee/min numbers.
//
// The rail (market/[id]/page.tsx) and the confirm modal (BetModal.tsx) used to
// compute these independently and disagree: the rail showed `floor(amount/price)`
// "Minimum shares" with no taker-fee note, while the modal showed
// `shares*(10000-takerFee)/10000` "after ~Polymarket fee", and the ~$1.25
// min-bet floor was enforced only in the modal. Both surfaces now derive every
// displayed number from `computeOrderPreview` so they are IDENTICAL, and the rail
// can surface the same min-bet floor before the user pays for a proof.
// ─────────────────────────────────────────────────────────────────────────────

/** Polymarket's per-order taker fee (bps), reserved from the stake before sizing.
 *  Inlined from NEXT_PUBLIC_CLOB_TAKER_FEE_BPS at build time; 0 → no net reduction. */
export const CLOB_TAKER_FEE_BPS =
  BigInt(process.env.NEXT_PUBLIC_CLOB_TAKER_FEE_BPS ?? '0')

// Polymarket enforces a $1 minimum ORDER NOTIONAL, and the signing layer reserves
// the per-market taker fee out of the stake BEFORE sizing the order — so a $1 bet
// sizes a sub-$1 order the CLOB rejects. Require enough headroom that the post-fee
// order clears $1 even at a generous (~20%) taker-fee assumption (~$1.25 floor).
// This sits ON TOP of the on-chain governance minBet.
const POLY_MIN_ORDER_USDC = 1_000_000n
const ORDER_FEE_HEADROOM_BPS = 2_000n // assume up to 20% taker-fee reserve (real ≈ 1–7%)
const POLY_MIN_ORDER_BET = (POLY_MIN_ORDER_USDC * 10_000n) / (10_000n - ORDER_FEE_HEADROOM_BPS)

// Polymarket rejects orders below 5 shares ("Size lower than the minimum: 5").
// shares is 1e6-scaled, so the floor is 5e6.
export const MIN_SHARES = 5_000_000n

export interface OrderPreviewInput {
  /** Bet stake in micro-USDC. */
  amountMicro: bigint
  /** Committed execution price (human units, e.g. 0.62). For a Market BUY this is the
   *  walk-the-book ceiling; for a Limit order the tick-snapped limit price. */
  effectivePrice: number
  /** Protocol fee rate (bps), from the Vault feeConfig. */
  protocolFeeBps: bigint
  /** Flat relay-gas fee in micro-USDC, from the Vault feeConfig. */
  relayGasMicro: bigint
  /** Polymarket taker fee (bps); defaults to CLOB_TAKER_FEE_BPS. */
  takerFeeBps?: bigint
  /** On-chain governance minimum bet in micro-USDC. The effective floor is the max
   *  of this and the Polymarket post-fee order floor (~$1.25). */
  minBetMicro: bigint
}

export interface OrderPreview {
  /** Fee-naive committed share cap (bet_amount / price), 1e6-scaled. */
  shares: bigint
  /** Estimated shares after the Polymarket taker fee comes out of the stake, 1e6-scaled. */
  sharesAfterTakerFee: bigint
  /** Protocol fee in micro-USDC (bet_amount * protocolFeeBps / 10000). */
  protocolFeeMicro: bigint
  /** Flat relay-gas fee in micro-USDC. */
  relayFeeMicro: bigint
  /** Vault-injected total fee (protocol + relay), in micro-USDC. Matches the bet_auth circuit. */
  totalFeeMicro: bigint
  /** amount + total fee, in micro-USDC — what leaves the note. */
  totalDeductedMicro: bigint
  /** True when the stake is below the effective minimum bet. */
  belowMin: boolean
  /** The effective minimum bet (max of governance minBet and the ~$1.25 order floor). */
  effectiveMinBetMicro: bigint
  /** True when the committed shares fall below Polymarket's 5-share minimum. */
  belowMinShares: boolean
}

/**
 * Single shared order-preview calculator. Both the rail and the modal MUST render
 * from this so the share/fee/min numbers are identical. The modal RESTATES this
 * preview; it must not recompute the numbers differently.
 */
export function computeOrderPreview(input: OrderPreviewInput): OrderPreview {
  const {
    amountMicro,
    effectivePrice,
    protocolFeeBps,
    relayGasMicro,
    takerFeeBps = CLOB_TAKER_FEE_BPS,
    minBetMicro,
  } = input

  const effectiveMinBetMicro = minBetMicro > POLY_MIN_ORDER_BET ? minBetMicro : POLY_MIN_ORDER_BET

  const positive = amountMicro > 0n
  const shares =
    positive && effectivePrice > 0
      ? (amountMicro * 100_000_000n) / BigInt(Math.round(effectivePrice * 100_000_000))
      : 0n
  const sharesAfterTakerFee = (shares * (10_000n - takerFeeBps)) / 10_000n

  const protocolFeeMicro = positive ? (amountMicro * protocolFeeBps) / 10_000n : 0n
  const relayFeeMicro = positive ? relayGasMicro : 0n
  const totalFeeMicro = protocolFeeMicro + relayFeeMicro

  return {
    shares,
    sharesAfterTakerFee,
    protocolFeeMicro,
    relayFeeMicro,
    totalFeeMicro,
    totalDeductedMicro: amountMicro + totalFeeMicro,
    belowMin: positive && amountMicro < effectiveMinBetMicro,
    effectiveMinBetMicro,
    belowMinShares: shares > 0n && shares < MIN_SHARES,
  }
}
