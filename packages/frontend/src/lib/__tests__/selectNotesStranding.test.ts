/**
 * Option A stranding-safety: selectNotesForAmount must never merge an open-position lineage away as a
 * non-slot-0 input (which would permanently strand that position's settlement/close payout). It
 * defaults the open-position set from the wallet's own BET_RECEIPT notes, so EVERY consolidation path
 * (withdraw, bet) is protected. These tests seed the note cache and assert the selection invariants.
 */

import { describe, it, expect, beforeEach } from 'vitest'

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
// addNote() fires a window CustomEvent (note-cache change); stub dispatchEvent for the node env.
;(globalThis as unknown as { dispatchEvent: () => boolean }).dispatchEvent = () => true

import { addNote, clearNoteCache, selectNotesForAmount, type Note } from '../notes'

const W = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65' as const
const hx = (s: string) => (`0x${s.padStart(64, '0')}`) as `0x${string}`

/** A spendable cash note on `depositIndex` with the given balance (one free note per lineage). */
function cash(depositIndex: number, balance: bigint): Note {
  return {
    id: `cash-${depositIndex}`,
    kind: 'DEPOSIT',
    owner_address: W,
    depositIndex,
    balance,
    nonce: 1n,
    commitment: hx(`c${depositIndex}`),
    nullifier: hx(`n${depositIndex}`),
    spent: false,
    createdAt: 0,
  }
}

/** A BET_RECEIPT making `depositIndex` an "open-position" lineage. */
function openReceipt(depositIndex: number): Note {
  return {
    id: `rcpt-${depositIndex}`,
    kind: 'BET_RECEIPT',
    owner_address: W,
    depositIndex,
    balance: 0n,
    nonce: 0n,
    commitment: hx(`r${depositIndex}`),
    nullifier: hx(`rn${depositIndex}`),
    nullifier_of_bet: hx(`rn${depositIndex}`),
    spent: false,
    createdAt: 0,
  }
}

beforeEach(() => {
  ;(globalThis as unknown as { localStorage: MemStorage }).localStorage.clear()
  clearNoteCache()
})

describe('selectNotesForAmount — Option A stranding safety', () => {
  it('prefers a clear-only merge and does NOT touch an open lineage when clear notes cover it', () => {
    addNote(cash(0, 100_000_000n)) // clear $100
    addNote(cash(1, 50_000_000n))  // open lineage $50
    addNote(openReceipt(1))

    const sel = selectNotesForAmount(W, 80_000_000n)
    expect(sel.ok).toBe(true)
    if (!sel.ok) return
    const deposits = sel.selection.notes.map((n) => n.depositIndex)
    expect(deposits).toContain(0)
    expect(deposits).not.toContain(1) // the open lineage is left untouched
  })

  it('forces the single open lineage to slot 0 so it survives the merge', () => {
    addNote(cash(0, 30_000_000n)) // clear $30
    addNote(cash(1, 80_000_000n)) // open lineage $80
    addNote(openReceipt(1))

    // $90 needs both notes → the open lineage MUST be slot 0 (consolidate continues notes[0]).
    const sel = selectNotesForAmount(W, 90_000_000n)
    expect(sel.ok).toBe(true)
    if (!sel.ok) return
    expect(sel.selection.notes.length).toBe(2)
    expect(sel.selection.notes[0].depositIndex).toBe(1) // open lineage anchors the merge
  })

  it('lets one open lineage be spent when the amount fits it alone (the other open lineage is untouched)', () => {
    addNote(cash(0, 60_000_000n)) // open lineage A
    addNote(openReceipt(0))
    addNote(cash(1, 60_000_000n)) // open lineage B
    addNote(openReceipt(1))

    const sel = selectNotesForAmount(W, 50_000_000n) // fits within one lineage
    expect(sel.ok).toBe(true)
    if (!sel.ok) return
    expect(sel.selection.notes.length).toBe(1)
    // Whichever single open lineage is chosen, it's forced to slot 0 (it's the only note → index 0).
    expect([0, 1]).toContain(sel.selection.notes[0].depositIndex)
  })

  it('REFUSES to merge two distinct open-position lineages (would strand one)', () => {
    addNote(cash(0, 60_000_000n)) // open lineage A
    addNote(openReceipt(0))
    addNote(cash(1, 60_000_000n)) // open lineage B
    addNote(openReceipt(1))

    // $100 needs BOTH open lineages — only one can be slot 0, so this must be refused.
    const sel = selectNotesForAmount(W, 100_000_000n)
    expect(sel.ok).toBe(false)
  })

  it('is unchanged when there are no open positions (greedy largest-first)', () => {
    addNote(cash(0, 40_000_000n))
    addNote(cash(1, 70_000_000n))
    const sel = selectNotesForAmount(W, 100_000_000n)
    expect(sel.ok).toBe(true)
    if (!sel.ok) return
    expect(sel.selection.notes.map((n) => n.depositIndex).sort()).toEqual([0, 1])
    expect(sel.selection.notes[0].depositIndex).toBe(1) // largest first
  })
})
