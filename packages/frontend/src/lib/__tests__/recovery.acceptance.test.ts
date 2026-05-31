/**
 * FC-5 acceptance fixture.
 *
 * A fresh client with EMPTY localStorage, given only a wallet signer and the Vault
 * address, must reconstruct identical balances, open positions, deposit/withdraw
 * history, and realized P&L — including FC-1 position closes — purely from on-chain
 * events. This test drives recoverNotesWithClient with a mocked PublicClient.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── minimal localStorage shim (notes.ts persists notes + activity through it) ──
class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, v) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}
;(globalThis as unknown as { window: unknown }).window = globalThis
;(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage()

import {
  recoverNotesWithClient,
  computeCommitment,
  computeNullifier,
  getWalletActivity,
  getSpendableNotes,
  clearNoteCache,
} from '../notes'

const WALLET = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65' as const
const VAULT = '0x0000000000000000000000000000000000009999' as const

// Returns an index-specific fake signature so each deposit index gets a unique secret.
// The derivation message embeds the index, so we parse it to vary the output.
const sign = vi.fn(async ({ message }: { message: string }) => {
  const m = message.match(/Index: (\d+)/)
  const idx = m ? parseInt(m[1]) : 0
  const hex = idx.toString(16).padStart(2, '0').repeat(64).slice(0, 128) + 'ef'
  return `0x${hex}` as `0x${string}`
})

import { deriveSecret } from '../notes'

const ZERO = `0x${'00'.repeat(32)}` as const
const b32 = (n: bigint) => (`0x${n.toString(16).padStart(64, '0')}`) as `0x${string}`

interface Log { blockNumber: bigint; transactionHash: string; args: Record<string, unknown> }

function makeClient(logsByEvent: Record<string, Log[]>, blockTs: Record<string, number>, pendingCredit = 0n) {
  return {
    getLogs: async ({ event }: { event: { name: string } }) => logsByEvent[event.name] ?? [],
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: BigInt(blockTs[String(blockNumber)] ?? 0) }),
    readContract: async () => pendingCredit,
  } as unknown as Parameters<typeof recoverNotesWithClient>[2]
}

beforeEach(() => {
  ;(globalThis as unknown as { localStorage: MemStorage }).localStorage.clear()
  clearNoteCache()
  vi.clearAllMocks()
})

describe('FC-5 recovery', () => {
  it('rebuilds balance, receipt position_id, real timestamps, and P&L for deposit→bet→full close', async () => {
    const secret0 = await deriveSecret(sign, WALLET, 0)
    const depositAmt = 1_000_000_000n // $1000
    const betAmt = 100_000_000n       // $100
    const shares = 200_000_000n       // 200 shares
    const proceeds = 120_000_000n     // $120 sale
    const positionId = b32(0x1234n)

    const depositC = computeCommitment(secret0, depositAmt, 0n, WALLET)
    const betNull = computeNullifier(secret0, 0n)
    const betOutC = computeCommitment(secret0, depositAmt - betAmt, 1n, WALLET) // balance after bet
    // close credits proceeds onto the post-bet free note (balance depositAmt-betAmt, nonce 1)
    const closeSpentNull = computeNullifier(secret0, 1n)
    const closeNewC = computeCommitment(secret0, depositAmt - betAmt + proceeds, 2n, WALLET)

    const logs: Record<string, Log[]> = {
      Deposited: [{ blockNumber: 10n, transactionHash: '0xdep', args: { depositor: WALLET, commitment: depositC, amount: depositAmt } }],
      BetAuthorized: [{ blockNumber: 11n, transactionHash: '0xbet', args: { nullifier: betNull, market_id: b32(7n), position_id: positionId, expected_shares: shares, bet_amount: betAmt, price: 50_000_000n, outcome_side: 0, new_commitment: betOutC } }],
      BetSold: [{ blockNumber: 12n, transactionHash: '0xsold', args: { nullifier_of_bet: betNull, sold_shares: shares, proceeds } }],
      PositionClosed: [{ blockNumber: 13n, transactionHash: '0xclose', args: { nullifier: closeSpentNull, nullifier_of_bet: betNull, new_commitment: closeNewC, fullClose: true } }],
      SettlementCredited: [], BetCancellationCredited: [], NACancellationCredited: [], Withdrawn: [],
    }
    const blockTs = { '10': 1_700_000_000, '11': 1_700_000_100, '12': 1_700_000_200, '13': 1_700_000_300 }

    const notes = await recoverNotesWithClient(WALLET, sign, makeClient(logs, blockTs), VAULT)

    // Final free note balance = 1000 - 100 + 120 = 1020
    const spendable = getSpendableNotes(WALLET).filter((n) => !n.spent)
    const cash = spendable.reduce((m, n) => (n.balance > m.balance ? n : m), spendable[0])
    expect(cash.balance).toBe(depositAmt - betAmt + proceeds)

    // Receipt carries position_id and is marked spent after a full close.
    const receipt = notes.find((n) => n.kind === 'BET_RECEIPT')!
    expect(receipt.position_id).toBe(positionId)
    expect(receipt.spent).toBe(true)

    // Real timestamps (not Date.now()).
    expect(cash.createdAt).toBe(1_700_000_300 * 1000)

    // Activity / realized P&L rebuilt from chain: close credited 120 on a 100 stake → +20.
    const activity = getWalletActivity(WALLET)
    expect(activity.find((a) => a.kind === 'deposit')?.amount).toBe(depositAmt)
    expect(activity.find((a) => a.kind === 'bet')?.amount).toBe(betAmt)
    const settle = activity.find((a) => a.kind === 'settlement')
    expect(settle?.amount).toBe(proceeds)
    expect(settle?.receiptId).toBe(receipt.id)
  })

  it('gap-scan finds deposits past an empty index', async () => {
    const s0 = await deriveSecret(sign, WALLET, 0)
    const s2 = await deriveSecret(sign, WALLET, 2)
    const c0 = computeCommitment(s0, 500_000_000n, 0n, WALLET)
    const c2 = computeCommitment(s2, 700_000_000n, 0n, WALLET)
    const logs: Record<string, Log[]> = {
      Deposited: [
        { blockNumber: 5n, transactionHash: '0xa', args: { depositor: WALLET, commitment: c0, amount: 500_000_000n } },
        { blockNumber: 6n, transactionHash: '0xb', args: { depositor: WALLET, commitment: c2, amount: 700_000_000n } },
      ],
      BetAuthorized: [], BetSold: [], PositionClosed: [], SettlementCredited: [], BetCancellationCredited: [], NACancellationCredited: [], Withdrawn: [],
    }
    const notes = await recoverNotesWithClient(WALLET, sign, makeClient(logs, { '5': 1, '6': 2 }), VAULT)
    const balances = notes.filter((n) => n.kind === 'DEPOSIT' && !n.spent).map((n) => n.balance).sort()
    expect(balances).toContain(500_000_000n)
    expect(balances).toContain(700_000_000n) // recovered despite empty index 1
  })

  it('partial close reduces receipt shares and keeps it open', async () => {
    const s = await deriveSecret(sign, WALLET, 0)
    const dep = 1_000_000_000n, bet = 100_000_000n, shares = 200_000_000n, sold = 120_000_000n, proceeds = 72_000_000n
    const depC = computeCommitment(s, dep, 0n, WALLET)
    const betNull = computeNullifier(s, 0n)
    const betOutC = computeCommitment(s, dep - bet, 1n, WALLET)
    const closeNull = computeNullifier(s, 1n)
    const closeNewC = computeCommitment(s, dep - bet + proceeds, 2n, WALLET)
    const logs: Record<string, Log[]> = {
      Deposited: [{ blockNumber: 1n, transactionHash: '0xd', args: { depositor: WALLET, commitment: depC, amount: dep } }],
      BetAuthorized: [{ blockNumber: 2n, transactionHash: '0xb', args: { nullifier: betNull, market_id: b32(1n), position_id: b32(9n), expected_shares: shares, bet_amount: bet, price: 50_000_000n, outcome_side: 0, new_commitment: betOutC } }],
      BetSold: [{ blockNumber: 3n, transactionHash: '0xs', args: { nullifier_of_bet: betNull, sold_shares: sold, proceeds } }],
      PositionClosed: [{ blockNumber: 4n, transactionHash: '0xc', args: { nullifier: closeNull, nullifier_of_bet: betNull, new_commitment: closeNewC, fullClose: false } }],
      SettlementCredited: [], BetCancellationCredited: [], NACancellationCredited: [], Withdrawn: [],
    }
    const notes = await recoverNotesWithClient(WALLET, sign, makeClient(logs, { '1': 1, '2': 2, '3': 3, '4': 4 }), VAULT)
    const receipt = notes.find((n) => n.kind === 'BET_RECEIPT')!
    expect(receipt.spent).toBe(false)                       // still open
    expect(receipt.expectedShares).toBe(shares - sold)      // reduced by sold portion
  })
})
