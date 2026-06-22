/**
 * Mark-to-market pricing for a held prediction-market position — the SINGLE source of truth shared by
 * the Portfolio table and the market-page "Your Position" panel, so the two surfaces can never show a
 * different P&L for the same position (a trust-killer for a money product).
 *
 * A binary outcome share pays $1 if it wins, $0 if it loses, so the live outcome price (0–1, the
 * market's implied probability) IS the current value per share. Entry price is derived from what the
 * user actually paid: stake / shares. Everything is plain numbers in DOLLARS; callers format.
 *
 * Privacy note: this is pure arithmetic over data the client already holds locally (stake/shares/side)
 * plus a public market midpoint — it touches no secret and makes no network call.
 */

const USDC = 1_000_000 // 1e6 scale for both micro-USDC and 1e6-scaled shares

export interface PositionPricing {
  shares: number // held shares (whole units)
  stake: number // cost basis in USDC (dollars)
  entryPrice: number | null // dollars/share paid (0–1), null if shares == 0
  markPrice: number | null // current dollars/share of the HELD side (0–1), null if unavailable
  value: number | null // shares * markPrice (dollars), null if mark unavailable
  pnl: number | null // value − stake (dollars), null if mark unavailable
  pnlPct: number | null // pnl / stake, null if mark unavailable or stake == 0
}

/**
 * @param yesMid live YES midpoint (0–1) or null if the price couldn't be fetched.
 * @param resolved true once the market has settled — then the mark is the binary `payout`, not a midpoint.
 * @param payout settlement value of the HELD side (0 or 1), used only when resolved.
 */
export function positionValue(args: {
  stakeMicro: bigint
  shares: bigint
  side: 'YES' | 'NO'
  yesMid: number | null
  resolved?: boolean
  payout?: number | null
}): PositionPricing {
  const shares = Number(args.shares) / USDC
  const stake = Number(args.stakeMicro) / USDC
  const entryPrice = shares > 0 ? stake / shares : null

  let markPrice: number | null
  if (args.resolved) {
    markPrice = args.payout ?? null
  } else if (args.yesMid == null || !Number.isFinite(args.yesMid)) {
    markPrice = null
  } else {
    const yes = Math.min(1, Math.max(0, args.yesMid))
    markPrice = args.side === 'YES' ? yes : 1 - yes
  }

  const value = markPrice == null ? null : shares * markPrice
  const pnl = value == null ? null : value - stake
  const pnlPct = pnl == null || stake <= 0 ? null : pnl / stake
  return { shares, stake, entryPrice, markPrice, value, pnl, pnlPct }
}

// ── Formatting (kept here so both surfaces render identically) ────────────────

/** A 0–1 price as cents, e.g. 0.6342 → "63.4¢". `null` → "—". */
export function fmtCents(price: number | null): string {
  if (price == null || !Number.isFinite(price)) return '—'
  return `${(price * 100).toFixed(1)}¢`
}

/** A signed dollar amount, e.g. +12.4 → "+$12.40", -3 → "−$3.00". `null` → "—". */
export function fmtSignedUsd(amount: number | null): string {
  if (amount == null || !Number.isFinite(amount)) return '—'
  const sign = amount > 0 ? '+' : amount < 0 ? '−' : ''
  return `${sign}$${Math.abs(amount).toFixed(2)}`
}

/** A signed percentage, e.g. 0.25 → "+25.0%". `null` → "". */
export function fmtSignedPct(pct: number | null): string {
  if (pct == null || !Number.isFinite(pct)) return ''
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : ''
  return `${sign}${Math.abs(pct * 100).toFixed(1)}%`
}

/** P&L direction → a design-token color + glyph (▲/▼/•). Color is NEVER the only signal (WCAG 1.4.1). */
export function pnlVisual(pnl: number | null): { color: string; glyph: string } {
  if (pnl == null || !Number.isFinite(pnl) || Math.abs(pnl) < 0.005) return { color: 'var(--text-3)', glyph: '•' }
  return pnl > 0 ? { color: 'var(--green)', glyph: '▲' } : { color: 'var(--red)', glyph: '▼' }
}
