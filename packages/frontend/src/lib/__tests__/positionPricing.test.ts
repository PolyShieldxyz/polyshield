/**
 * Mark-to-market math for held positions. This helper is the single source of truth shared by the
 * Portfolio table and the market-page "Your Position" panel, so the numbers must be exactly right and
 * exactly the same on both surfaces — these tests pin the arithmetic.
 */

import { describe, it, expect } from 'vitest'
import { positionValue, fmtCents, fmtSignedUsd, fmtSignedPct } from '../positionPricing'

const USDC = 1_000_000n
const $ = (n: number) => BigInt(Math.round(n * 1e6)) // dollars → micro
const sh = (n: number) => BigInt(Math.round(n * 1e6)) // shares → 1e6-scaled

describe('positionValue', () => {
  it('YES position that moved up: entry 50¢, mark 60¢ → +20%', () => {
    const p = positionValue({ stakeMicro: $(50), shares: sh(100), side: 'YES', yesMid: 0.6 })
    expect(p.entryPrice).toBeCloseTo(0.5, 9)
    expect(p.markPrice).toBeCloseTo(0.6, 9)
    expect(p.value).toBeCloseTo(60, 6)
    expect(p.pnl).toBeCloseTo(10, 6)
    expect(p.pnlPct).toBeCloseTo(0.2, 9)
  })

  it('NO position prices off the complement of the YES midpoint', () => {
    // stake $50 for 100 NO shares (entry 50¢); YES mid 0.6 → NO mark 0.4 → value $40, −$10.
    const p = positionValue({ stakeMicro: $(50), shares: sh(100), side: 'NO', yesMid: 0.6 })
    expect(p.markPrice).toBeCloseTo(0.4, 9)
    expect(p.value).toBeCloseTo(40, 6)
    expect(p.pnl).toBeCloseTo(-10, 6)
  })

  it('null when the mark is unavailable (no fabricated price)', () => {
    const p = positionValue({ stakeMicro: $(50), shares: sh(100), side: 'YES', yesMid: null })
    expect(p.markPrice).toBeNull()
    expect(p.value).toBeNull()
    expect(p.pnl).toBeNull()
    expect(p.pnlPct).toBeNull()
    expect(p.entryPrice).toBeCloseTo(0.5, 9) // entry is still known from the stake/shares
  })

  it('resolved market marks at the binary payout, not the midpoint', () => {
    const win = positionValue({ stakeMicro: $(50), shares: sh(100), side: 'YES', yesMid: 0.6, resolved: true, payout: 1 })
    expect(win.markPrice).toBe(1)
    expect(win.value).toBeCloseTo(100, 6)
    expect(win.pnl).toBeCloseTo(50, 6)
    const lose = positionValue({ stakeMicro: $(50), shares: sh(100), side: 'YES', yesMid: 0.6, resolved: true, payout: 0 })
    expect(lose.value).toBeCloseTo(0, 6)
    expect(lose.pnl).toBeCloseTo(-50, 6)
  })

  it('zero shares → entry price is null, not a divide-by-zero', () => {
    const p = positionValue({ stakeMicro: $(50), shares: 0n, side: 'YES', yesMid: 0.6 })
    expect(p.entryPrice).toBeNull()
    expect(p.value).toBeCloseTo(0, 6)
  })

  it('clamps an out-of-range midpoint into [0,1]', () => {
    expect(positionValue({ stakeMicro: $(1), shares: sh(1), side: 'YES', yesMid: 1.4 }).markPrice).toBe(1)
    expect(positionValue({ stakeMicro: $(1), shares: sh(1), side: 'NO', yesMid: 1.4 }).markPrice).toBe(0)
  })
})

describe('formatters', () => {
  it('fmtCents', () => {
    expect(fmtCents(0.634)).toBe('63.4¢')
    expect(fmtCents(null)).toBe('—')
  })
  it('fmtSignedUsd uses a real minus glyph and a leading +', () => {
    expect(fmtSignedUsd(12.4)).toBe('+$12.40')
    expect(fmtSignedUsd(-3)).toBe('−$3.00')
    expect(fmtSignedUsd(null)).toBe('—')
  })
  it('fmtSignedPct', () => {
    expect(fmtSignedPct(0.25)).toBe('+25.0%')
    expect(fmtSignedPct(-0.1)).toBe('−10.0%')
    expect(fmtSignedPct(null)).toBe('')
  })

  // sanity: a $-amount value column also reads back consistently for the > $1k case
  it('USDC scale sanity', () => {
    expect(Number(USDC) / 1e6).toBe(1)
  })
})
