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
