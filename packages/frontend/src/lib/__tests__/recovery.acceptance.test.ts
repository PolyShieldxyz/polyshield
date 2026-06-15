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

import { keccak256, toBytes } from 'viem'
import {
  recoverNotesWithClient,
  computeCommitment,
  computeNullifier,
  getWalletActivity,
  getSpendableNotes,
  clearNoteCache,
  byBlockThenLogIndex,
  deriveMasterSeed,
  deriveSecretV2,
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

// FEE: feeConfig tuple = [betFeeBps, relayGasFeeUSDC, minBet, withdrawalFeeUSDC, minWithdrawal, feeRecipient].
// Default is all-zero (no fee) so pre-fee fixtures recover unchanged.
type FeeConfig = readonly [number, bigint, bigint, bigint, bigint, `0x${string}`]
const NO_FEE: FeeConfig = [0, 0n, 0n, 0n, 0n, '0x0000000000000000000000000000000000000000']

function makeClient(
  logsByEvent: Record<string, Log[]>,
  blockTs: Record<string, number>,
  pendingCredit = 0n,
  feeConfig: FeeConfig = NO_FEE,
  // FC-4 partial-fill recovery reads the POST-normalization betRecord (expected_shares=filled,
  // bet_amount=spent) to derive the refund. Keyed by nullifier_of_bet (lowercase).
  betRecords: Record<string, { expectedShares: bigint; betAmount: bigint }> = {},
) {
  return {
    // recoverNotesWithClient now pages getLogs over [fromBlock, getBlockNumber()] in ≤9000-block
    // windows. The getLogs mock ignores the range, so return a tip well within ONE window (test
    // logs sit at blocks 1–11) — a larger value would split into multiple windows and replay the
    // canned logs more than once.
    getBlockNumber: async () => 100n,
    getLogs: async ({ event }: { event: { name: string } }) => logsByEvent[event.name] ?? [],
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: BigInt(blockTs[String(blockNumber)] ?? 0) }),
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      if (functionName === 'feeConfig') return feeConfig
      if (functionName === 'betRecords') {
        const r = betRecords[String(args?.[0] ?? '').toLowerCase()] ?? { expectedShares: 0n, betAmount: 0n }
        // getter tuple: [market_id, condition_id, position_id, expected_shares(3), bet_amount(4),
        // outcome_side, status, sell_proceeds, sold_shares, filled_shares, spent_amount].
        return [ZERO, ZERO, ZERO, r.expectedShares, r.betAmount, 0, 1, 0n, 0n, 0n, 0n]
      }
      return pendingCredit
    },
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

  it('FC-4/L3: partial-fill credit refunds the unfilled remainder and keeps the receipt open (normalized)', async () => {
    const secret0 = await deriveSecret(sign, WALLET, 0)
    const depositAmt = 1_000_000_000n // $1000
    const betAmt = 100_000_000n       // $100 committed stake
    const shares = 200_000_000n       // 200 committed (max) shares
    const filled = 120_000_000n       // 120 actually filled (normalized expected_shares)
    const spent = 60_000_000n         // $60 actually spent (normalized bet_amount)
    const refund = betAmt - spent     // $40 unfilled remainder → refunded
    const positionId = b32(0x1234n)

    const depositC = computeCommitment(secret0, depositAmt, 0n, WALLET)
    const betNull = computeNullifier(secret0, 0n)
    const betOutC = computeCommitment(secret0, depositAmt - betAmt, 1n, WALLET) // after −$100
    // partial credit spends the post-bet free note (balance depositAmt−betAmt, nonce 1) + adds refund
    const partialSpentNull = computeNullifier(secret0, 1n)
    const partialNewC = computeCommitment(secret0, depositAmt - betAmt + refund, 2n, WALLET)

    const logs: Record<string, Log[]> = {
      Deposited: [{ blockNumber: 10n, transactionHash: '0xdep', args: { depositor: WALLET, commitment: depositC, amount: depositAmt } }],
      BetAuthorized: [{ blockNumber: 11n, transactionHash: '0xbet', args: { nullifier: betNull, market_id: b32(7n), position_id: positionId, expected_shares: shares, bet_amount: betAmt, price: 50_000_000n, outcome_side: 0, new_commitment: betOutC } }],
      PartialFillCredited: [{ blockNumber: 12n, transactionHash: '0xpartial', args: { nullifier: partialSpentNull, nullifier_of_bet: betNull, new_commitment: partialNewC } }],
      BetSold: [], PositionClosed: [], SettlementCredited: [], BetCancellationCredited: [], NACancellationCredited: [], Withdrawn: [],
    }
    const blockTs = { '10': 1_700_000_000, '11': 1_700_000_100, '12': 1_700_000_200 }
    // The POST-normalization on-chain record: expected_shares=filled, bet_amount=spent.
    const betRecords = { [betNull.toLowerCase()]: { expectedShares: filled, betAmount: spent } }

    const notes = await recoverNotesWithClient(WALLET, sign, makeClient(logs, blockTs, 0n, NO_FEE, betRecords), VAULT)

    // Cash note = 1000 − 100 + 40 refund = 940.
    const spendable = getSpendableNotes(WALLET).filter((n) => !n.spent)
    const cash = spendable.reduce((m, n) => (n.balance > m.balance ? n : m), spendable[0])
    expect(cash.balance).toBe(depositAmt - betAmt + refund)

    // Receipt stays OPEN (filled position settles/closes later), normalized to the actual fill.
    const receipt = notes.find((n) => n.kind === 'BET_RECEIPT')!
    expect(receipt.spent).toBe(false)
    expect(receipt.expectedShares).toBe(filled)
    expect(receipt.bet_amount).toBe(spent)

    // Refund recorded as a capital-return activity (amount = the unfilled remainder).
    const refundEv = getWalletActivity(WALLET).find((a) => a.kind === 'refund')
    expect(refundEv?.amount).toBe(refund)
    expect(refundEv?.receiptId).toBe(receipt.id)
  })

  it('FEE: reconstructs the post-bet balance net of the Vault-injected bet fee', async () => {
    const secret0 = await deriveSecret(sign, WALLET, 0)
    const depositAmt = 1_000_000_000n // $1000
    const betAmt = 100_000_000n       // $100
    const betFeeBps = 5n              // 0.05%
    const fee = (betAmt * betFeeBps) / 10_000n // = 50_000 ($0.05)
    const shares = 200_000_000n

    const depositC = computeCommitment(secret0, depositAmt, 0n, WALLET)
    const betNull = computeNullifier(secret0, 0n)
    // The on-chain post-bet commitment binds balance - bet_amount - fee.
    const betOutC = computeCommitment(secret0, depositAmt - betAmt - fee, 1n, WALLET)

    const logs: Record<string, Log[]> = {
      Deposited: [{ blockNumber: 10n, transactionHash: '0xdep', args: { depositor: WALLET, commitment: depositC, amount: depositAmt } }],
      BetAuthorized: [{ blockNumber: 11n, transactionHash: '0xbet', args: { nullifier: betNull, market_id: b32(7n), position_id: b32(0x1234n), expected_shares: shares, bet_amount: betAmt, price: 50_000_000n, outcome_side: 0, new_commitment: betOutC } }],
      BetSold: [], PositionClosed: [], SettlementCredited: [], BetCancellationCredited: [], NACancellationCredited: [], Withdrawn: [],
    }
    const feeConfig: FeeConfig = [5, 0n, 1_000_000n, 100_000n, 1_000_000n, '0x0000000000000000000000000000000000000000']
    await recoverNotesWithClient(WALLET, sign, makeClient(logs, { '10': 1, '11': 2 }, 0n, feeConfig), VAULT)

    // Recovered cash note = 1000 - 100 - 0.05 = 899.95 (in micro-USDC).
    const spendable = getSpendableNotes(WALLET).filter((n) => !n.spent)
    const cash = spendable.reduce((m, n) => (n.balance > m.balance ? n : m), spendable[0])
    expect(cash.balance).toBe(depositAmt - betAmt - fee)
    expect(cash.commitment.toLowerCase()).toBe(betOutC.toLowerCase())
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

  it('FC-8: rebuilds a consolidate (merge two deposits) then bet from the merged note', async () => {
    const s0 = await deriveSecret(sign, WALLET, 0)
    const s1 = await deriveSecret(sign, WALLET, 1)
    const amt0 = 600_000_000n // $600
    const amt1 = 400_000_000n // $400
    const merged = amt0 + amt1 // $1000
    const bet = 100_000_000n

    const dep0 = computeCommitment(s0, amt0, 0n, WALLET)
    const dep1 = computeCommitment(s1, amt1, 0n, WALLET)
    const null0 = computeNullifier(s0, 0n) // slot 0 (anchors merged lineage)
    const null1 = computeNullifier(s1, 0n) // contributor
    // merged note continues slot-0's lineage: (s0, merged, nonce 1)
    const mergedC = computeCommitment(s0, merged, 1n, WALLET)
    // bet spends the merged note (s0, nonce 1) -> change note (s0, merged-bet, nonce 2)
    const betNull = computeNullifier(s0, 1n)
    const betOutC = computeCommitment(s0, merged - bet, 2n, WALLET)

    const logs: Record<string, Log[]> = {
      Deposited: [
        { blockNumber: 1n, transactionHash: '0xd0', args: { depositor: WALLET, commitment: dep0, amount: amt0 } },
        { blockNumber: 2n, transactionHash: '0xd1', args: { depositor: WALLET, commitment: dep1, amount: amt1 } },
      ],
      Consolidated: [
        { blockNumber: 3n, transactionHash: '0xcons', args: { nullifiers: [null0, null1, ZERO, ZERO], new_commitment: mergedC } },
      ],
      BetAuthorized: [
        { blockNumber: 4n, transactionHash: '0xbet', args: { nullifier: betNull, market_id: b32(3n), position_id: b32(9n), expected_shares: 200_000_000n, bet_amount: bet, price: 50_000_000n, outcome_side: 0, new_commitment: betOutC } },
      ],
      BetSold: [], PositionClosed: [], SettlementCredited: [], BetCancellationCredited: [], NACancellationCredited: [], Withdrawn: [],
    }
    const blockTs = { '1': 1, '2': 2, '3': 3, '4': 4 }
    const notes = await recoverNotesWithClient(WALLET, sign, makeClient(logs, blockTs), VAULT)

    // The merged lineage's free note holds (600 + 400 - 100) = 900 after the bet.
    const spendable = getSpendableNotes(WALLET).filter((n) => !n.spent)
    expect(spendable.length).toBe(1)
    expect(spendable[0].balance).toBe(merged - bet)

    // Both deposit lineages are consumed (spent) by the consolidation.
    const deposits = notes.filter((n) => n.kind === 'DEPOSIT')
    expect(deposits.length).toBe(2)
    expect(deposits.every((n) => n.spent)).toBe(true)

    // The bet against the merged note produced a receipt.
    expect(notes.some((n) => n.kind === 'BET_RECEIPT' && n.nullifier === betNull)).toBe(true)
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

// FC-13: V2 master-seed recovery + backward-compat with legacy V1 notes.
describe('FC-13 master-seed recovery', () => {
  // Deterministic signer: signature = keccak256(message). Reproducible per message, as wallets are.
  const detSign = vi.fn(async ({ message }: { message: string }) => keccak256(toBytes(message)))
  const emptyEvents = {
    BetAuthorized: [], BetSold: [], PositionClosed: [], SettlementCredited: [],
    BetCancellationCredited: [], NACancellationCredited: [], PartialFillCredited: [],
    Consolidated: [], Withdrawn: [],
  }

  it('recovers an all-V2 wallet with exactly ONE signature and tags notes version 2', async () => {
    const seed = await deriveMasterSeed(detSign, WALLET)
    const s0 = deriveSecretV2(seed, 0)
    const s1 = deriveSecretV2(seed, 1)
    const amt0 = 500_000_000n
    const amt1 = 700_000_000n
    const logs: Record<string, Log[]> = {
      Deposited: [
        { blockNumber: 5n, transactionHash: '0xa', args: { depositor: WALLET, commitment: computeCommitment(s0, amt0, 0n, WALLET), amount: amt0 } },
        { blockNumber: 6n, transactionHash: '0xb', args: { depositor: WALLET, commitment: computeCommitment(s1, amt1, 0n, WALLET), amount: amt1 } },
      ],
      ...emptyEvents,
    }
    vi.clearAllMocks() // forget the seed-derivation call used only to build the fixtures
    const notes = await recoverNotesWithClient(WALLET, detSign, makeClient(logs, { '5': 1, '6': 2 }), VAULT)

    // ONE signature for the whole wallet (the master seed) — no per-index prompts, no V1 fallback.
    expect(detSign).toHaveBeenCalledTimes(1)
    const deposits = notes.filter((n) => n.kind === 'DEPOSIT')
    expect(deposits.length).toBe(2)
    expect(deposits.every((n) => n.derivationVersion === 2)).toBe(true)
    const balances = deposits.map((n) => n.balance).sort()
    expect(balances).toContain(amt0)
    expect(balances).toContain(amt1)
  })

  it('recovers a mixed V1+V2 wallet, tagging each lineage with its own version', async () => {
    const sign = vi.fn(async ({ message }: { message: string }) => keccak256(toBytes(message)))
    // index 0 = legacy V1 (per-index signature); index 1 = V2 (master seed).
    const seed = await deriveMasterSeed(sign, WALLET)
    const s0 = await deriveSecret(sign, WALLET, 0) // V1 primitive — what recovery's fallback recomputes
    const s1 = deriveSecretV2(seed, 1)
    const amt0 = 300_000_000n
    const amt1 = 800_000_000n
    const logs: Record<string, Log[]> = {
      Deposited: [
        { blockNumber: 5n, transactionHash: '0xa', args: { depositor: WALLET, commitment: computeCommitment(s0, amt0, 0n, WALLET), amount: amt0 } },
        { blockNumber: 6n, transactionHash: '0xb', args: { depositor: WALLET, commitment: computeCommitment(s1, amt1, 0n, WALLET), amount: amt1 } },
      ],
      ...emptyEvents,
    }
    const notes = await recoverNotesWithClient(WALLET, sign, makeClient(logs, { '5': 1, '6': 2 }), VAULT)
    const deposits = notes.filter((n) => n.kind === 'DEPOSIT')
    expect(deposits.length).toBe(2)
    const versionByBalance = Object.fromEntries(deposits.map((n) => [n.balance.toString(), n.derivationVersion]))
    expect(versionByBalance[amt0.toString()]).toBe(1) // legacy lineage
    expect(versionByBalance[amt1.toString()]).toBe(2) // master-seed lineage
  })
})

// FC-14: the exact fee split is in the BetAuthorized event, so recovery reconstructs the post-bet
// balance precisely even if governance changed the rate afterward (kills the old rate-change bug).
describe('FC-14 fee recovery', () => {
  it('uses the event fee, not the current feeConfig, to rebuild the post-bet balance', async () => {
    const secret0 = await deriveSecret(sign, WALLET, 0)
    const depositAmt = 1_000_000_000n
    const betAmt = 100_000_000n
    const protocolFee = 200_000n // 0.2% recorded at bet time
    const relayFee = 0n
    const shares = 200_000_000n
    const depositC = computeCommitment(secret0, depositAmt, 0n, WALLET)
    const betNull = computeNullifier(secret0, 0n)
    const betOutC = computeCommitment(secret0, depositAmt - betAmt - protocolFee - relayFee, 1n, WALLET)
    const logs: Record<string, Log[]> = {
      Deposited: [{ blockNumber: 10n, transactionHash: '0xdep', args: { depositor: WALLET, commitment: depositC, amount: depositAmt } }],
      BetAuthorized: [{ blockNumber: 11n, transactionHash: '0xbet', args: { nullifier: betNull, market_id: b32(7n), position_id: b32(1n), expected_shares: shares, bet_amount: betAmt, price: 50_000_000n, outcome_side: 0, new_commitment: betOutC, protocolFee, relayFee } }],
      BetSold: [], PositionClosed: [], SettlementCredited: [], BetCancellationCredited: [], NACancellationCredited: [], Withdrawn: [],
    }
    // Current feeConfig has a DIFFERENT (much higher) rate — recovery must IGNORE it and use the
    // per-bet fee from the event. The legacy recompute path would mis-reconstruct here.
    const laterRate: FeeConfig = [99, 0n, 1_000_000n, 100_000n, 1_000_000n, '0x0000000000000000000000000000000000000000']
    await recoverNotesWithClient(WALLET, sign, makeClient(logs, { '10': 1, '11': 2 }, 0n, laterRate), VAULT)

    const spendable = getSpendableNotes(WALLET).filter((n) => !n.spent)
    const cash = spendable.reduce((m, n) => (n.balance > m.balance ? n : m), spendable[0])
    expect(cash.balance).toBe(depositAmt - betAmt - protocolFee) // exact, from the event
    expect(cash.commitment.toLowerCase()).toBe(betOutC.toLowerCase())
  })
})

// FC-1 regression: BetSold proceeds must pair to the matching PositionClosed by
// (blockNumber, logIndex), the SAME ordering the merged event timeline uses. A
// block-only sort could mis-pair two events of one bet that land in the same block.
describe('byBlockThenLogIndex (recovery pairing order)', () => {
  interface L { blockNumber?: bigint | null; logIndex?: number | null; tag: string }

  it('orders by blockNumber first', () => {
    const logs: L[] = [
      { blockNumber: 20n, logIndex: 0, tag: 'b' },
      { blockNumber: 10n, logIndex: 5, tag: 'a' },
    ]
    expect([...logs].sort(byBlockThenLogIndex).map((l) => l.tag)).toEqual(['a', 'b'])
  })

  it('breaks ties within a block by logIndex (same-block earlier then later sale)', () => {
    const earlier: L = { blockNumber: 100n, logIndex: 2, tag: 'first:40' }
    const later: L = { blockNumber: 100n, logIndex: 7, tag: 'second:70' }
    expect([later, earlier].sort(byBlockThenLogIndex).map((l) => l.tag)).toEqual([
      'first:40',
      'second:70',
    ])
  })

  it('treats missing block/index as 0 without throwing', () => {
    const logs: L[] = [
      { logIndex: 3, tag: 'noBlock' },
      { blockNumber: 1n, logIndex: 0, tag: 'block1' },
    ]
    expect([...logs].sort(byBlockThenLogIndex).map((l) => l.tag)).toEqual(['noBlock', 'block1'])
  })
})
