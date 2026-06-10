/**
 * Follow-up 2: P&L cost-basis netting. After a partial fill, the unfilled remainder is refunded
 * and the FILLED position settles separately — so the settlement's cost basis is `spent`
 * (= committed − refunded), not the committed stake. These tests drive loadPortfolioState's
 * closedBetHistory directly from seeded activity (no notes → no settlement-status network reads).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Node env: shim window + localStorage (notes.ts persistence guards on `typeof window`).
class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, v) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}
;(globalThis as unknown as { window: unknown }).window = globalThis
;(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage()

// accountState imports wagmi hooks at module scope; loadPortfolioState never calls them, so stub
// the module so the import resolves in the node test environment.
vi.mock('wagmi', () => ({
  useBlockNumber: () => ({ data: undefined }),
  useDisconnect: () => ({ disconnect: () => undefined }),
  usePublicClient: () => undefined,
}))

import { recordWalletActivity, clearNoteCache } from '../notes'
import { loadPortfolioState } from '../accountState'

const W = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65' as const

beforeEach(() => {
  ;(globalThis as unknown as { localStorage: MemStorage }).localStorage.clear()
  clearNoteCache()
})

describe('accountState P&L cost-basis (follow-up 2)', () => {
  it('nets a partial-fill refund into the settlement cost basis: P&L = settlement − spent', async () => {
    const receiptId = 'receipt-0xpartialbet'
    // Bet $100 committed; the order partially filled (spent $60), so $40 was refunded; the filled
    // position later settled for $72. True P&L on the held position = 72 − 60 = +12 (NOT 72 − 100).
    recordWalletActivity({ id: 'bet-x', wallet: W, kind: 'bet', amount: 100_000_000n, createdAt: 1, receiptId, receiptNullifier: '0xabc' as `0x${string}` })
    recordWalletActivity({ id: 'partial-x', wallet: W, kind: 'refund', amount: 40_000_000n, createdAt: 2, receiptId })
    recordWalletActivity({ id: 'settle-x', wallet: W, kind: 'settlement', amount: 72_000_000n, createdAt: 3, receiptId })

    const state = await loadPortfolioState(W)

    const settle = state.closedBetHistory.find((r) => r.kind === 'settlement')!
    expect(settle.betAmount).toBe(60_000_000n) // committed 100 − refunded 40 = spent 60
    expect(settle.pnl).toBe(12_000_000n)        // 72 − 60 (not the old 72 − 100 = −28)

    // The refund itself is a capital return → P&L 0 (no phantom loss).
    const refund = state.closedBetHistory.find((r) => r.kind === 'refund')!
    expect(refund.pnl).toBe(0n)

    // Net realized P&L counts the +12 once (refund contributes 0).
    expect(state.totalPnL).toBe(12_000_000n)
  })

  it('a bet with no partial refund is unchanged: P&L = settlement − committed stake', async () => {
    const receiptId = 'receipt-0xfullbet'
    recordWalletActivity({ id: 'bet-y', wallet: W, kind: 'bet', amount: 100_000_000n, createdAt: 1, receiptId, receiptNullifier: '0xdef' as `0x${string}` })
    recordWalletActivity({ id: 'settle-y', wallet: W, kind: 'settlement', amount: 130_000_000n, createdAt: 2, receiptId })

    const state = await loadPortfolioState(W)
    const settle = state.closedBetHistory.find((r) => r.kind === 'settlement')!
    expect(settle.betAmount).toBe(100_000_000n)
    expect(settle.pnl).toBe(30_000_000n) // 130 − 100
  })
})
