/**
 * Option D — "Settle & Withdraw": one-click force-close everything, then withdraw the full balance.
 *
 * Best-effort liquidation that drives the existing credit/cancel primitives in order:
 *   1. SETTLE   every resolved winner            → settlePosition
 *   2. RECLAIM  every never-filled (resolved) bet → reclaimBet; retire lost bets (payout 0)
 *   3. CLOSE    every remaining open position     → reclaim (RESTING) or market-sell + finalizeClose
 *   4. WITHDRAW everything safely withdrawable     → full drain of every CLEAR lineage
 *
 * Every step advances its lineage's tip note; the primitives re-resolve the tip from the (synchronously
 * updated) note cache, so same-lineage steps stay correct. Each primitive checks on-chain terminal
 * status first, so a partial run (or a race with the portfolio poll) resumes/re-runs without
 * double-spending. Positions the operator can't terminalize in the poll window are LEFT OPEN
 * (dust-preserved) and reported in `skipped`; the final withdraw never touches an open lineage, so a
 * timed-out position is never stranded.
 *
 * Privacy/soundness: every credit lands in a note (nothing secret leaves the client); the final
 * withdrawal is W-to-W; all proofs use the existing circuits unchanged.
 */

import { loadPortfolioState } from './accountState'
import {
  addNote,
  computeCommitment,
  computeNullifier,
  computeRecipientHash,
  getFreeNotes,
  getOpenBetReceipts,
  markBetReceiptSpent,
  markNoteSpent,
  MAX_CONSOLIDATE_INPUTS,
  reconcileSpentStatus,
  recordWalletActivity,
  selectNotesForAmount,
  type Note,
} from './notes'
import {
  BET_STATUS,
  fetchBetRecord,
  fetchMerklePath,
  relayWithdrawal,
  waitForTransactionConfirmation,
} from './api'
import { consolidateNotes } from './consolidate'
import { getNoteSecret } from './secretSession'
import { generateProofInWorker } from './prover'
import { settlePosition } from './settlePosition'
import { submitMarketClose } from './submitMarketClose'
import { reclaimBet } from './cancelAndReclaim'
import { finalizeClose } from './finalizeClose'
import { clearCloseMarker } from './closeMarker'

const ZERO_COMMITMENT = `0x${'00'.repeat(32)}` as `0x${string}`
// A market (FAK) SELL fills in seconds or is killed; poll the SOLD attestation up to ~90s before
// leaving the position open (aligned with the portfolio's MARKET_CLOSE_STALE window).
const SOLD_POLL_MS = 4_000
const SOLD_POLL_MAX = 22

type SignFn = (args: { message: string }) => Promise<`0x${string}`>

export interface SettleCloseProgress {
  phase: 'settling' | 'reclaiming' | 'closing' | 'withdrawing' | 'done'
  done: number
  total: number
  message: string
}

export interface SettleCloseResult {
  withdrawnAmount: bigint
  settled: number
  closed: number
  reclaimed: number
  skipped: Array<{ receipt: Note; reason: string }>
  errors: Array<{ receipt: Note | null; error: string }>
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export async function settleCloseAndWithdraw(
  address: `0x${string}`,
  vaultAddress: `0x${string}`,
  signMessageAsync: SignFn,
  onProgress: (p: SettleCloseProgress) => void,
): Promise<SettleCloseResult> {
  const result: SettleCloseResult = {
    withdrawnAmount: 0n,
    settled: 0,
    closed: 0,
    reclaimed: 0,
    skipped: [],
    errors: [],
  }

  await reconcileSpentStatus(address).catch(() => undefined)
  let state = await loadPortfolioState(address)

  // ── Phase 1: settle resolved winners ───────────────────────────────────────
  const ready = state.readyToSettle
  for (let i = 0; i < ready.length; i++) {
    onProgress({ phase: 'settling', done: i, total: ready.length, message: `Settling resolved bet ${i + 1} of ${ready.length}…` })
    try {
      const r = await settlePosition(address, ready[i], vaultAddress, signMessageAsync)
      if (r.done) result.settled++
      else result.skipped.push({ receipt: ready[i].receipt, reason: r.reason ?? 'not-settled' })
    } catch (e) {
      result.errors.push({ receipt: ready[i].receipt, error: errMsg(e) })
    }
  }

  await reconcileSpentStatus(address).catch(() => undefined)
  state = await loadPortfolioState(address)

  // ── Phase 2: reclaim never-filled bets; retire lost bets ────────────────────
  // Lost bets credit nothing (payout 0) and strand nothing — retire them locally so the final withdraw
  // can fully drain their lineage.
  for (const lost of state.lostBets) {
    markBetReceiptSpent((lost.nullifier_of_bet ?? lost.nullifier) as `0x${string}`)
  }
  const unfilled = state.unfilledResolved
  for (let i = 0; i < unfilled.length; i++) {
    onProgress({ phase: 'reclaiming', done: i, total: unfilled.length, message: `Reclaiming unfilled order ${i + 1} of ${unfilled.length}…` })
    try {
      const r = await reclaimBet(address, unfilled[i], vaultAddress, signMessageAsync)
      if (r.done) result.reclaimed++
      else result.skipped.push({ receipt: unfilled[i], reason: r.reason ?? 'not-reclaimed' })
    } catch (e) {
      result.errors.push({ receipt: unfilled[i], error: errMsg(e) })
    }
  }

  await reconcileSpentStatus(address).catch(() => undefined)
  state = await loadPortfolioState(address)

  // ── Phase 3: handle every remaining OPEN receipt by on-chain status ─────────
  // Retire lost bets from the freshest state (resolved, payout 0 — nothing to close, strands nothing)
  // and exclude them, so a ~90s market-sell is never wasted on an already-resolved market.
  for (const lost of state.lostBets) {
    markBetReceiptSpent((lost.nullifier_of_bet ?? lost.nullifier) as `0x${string}`)
  }
  const lostIds = new Set(state.lostBets.map((n) => n.id))
  const remaining = state.openReceipts.filter((r) => !lostIds.has(r.id))
  for (let i = 0; i < remaining.length; i++) {
    const receipt = remaining[i]
    const nob = (receipt.nullifier_of_bet ?? receipt.nullifier) as `0x${string}`
    onProgress({ phase: 'closing', done: i, total: remaining.length, message: `Closing position ${i + 1} of ${remaining.length}…` })
    try {
      const rec = await fetchBetRecord(vaultAddress, nob)
      // Already terminal on-chain → retire the local receipt.
      if (
        rec.status === BET_STATUS.CREDITED ||
        rec.status === BET_STATUS.CANCELLED_CREDITED ||
        rec.status === BET_STATUS.CLOSED_CREDITED
      ) {
        markBetReceiptSpent(nob)
        continue
      }
      // A resting limit order holds no shares → cancel + reclaim the stake.
      if (rec.status === BET_STATUS.RESTING) {
        const r = await reclaimBet(address, receipt, vaultAddress, signMessageAsync)
        if (r.done) result.reclaimed++
        else result.skipped.push({ receipt, reason: r.reason ?? 'still-resting' })
        continue
      }
      // A filled position with unsold shares → market-sell + credit proceeds.
      const hasShares = rec.expectedShares > rec.soldShares && rec.expectedShares > 0n
      if (receipt.position_id && hasShares) {
        const r = await closePositionFull(address, receipt, vaultAddress, signMessageAsync, (m) =>
          onProgress({ phase: 'closing', done: i, total: remaining.length, message: m }))
        if (r.done) result.closed++
        else result.skipped.push({ receipt, reason: r.reason })
        continue
      }
      // Pending / never-filled with no shares (e.g. a market order still in flight) → try a cancel-reclaim.
      const r = await reclaimBet(address, receipt, vaultAddress, signMessageAsync)
      if (r.done) result.reclaimed++
      else result.skipped.push({ receipt, reason: r.reason ?? 'pending' })
    } catch (e) {
      result.errors.push({ receipt, error: errMsg(e) })
    }
  }

  // ── Phase 4: withdraw everything safely withdrawable ────────────────────────
  onProgress({ phase: 'withdrawing', done: 0, total: 1, message: 'Withdrawing your balance…' })
  try {
    result.withdrawnAmount = await withdrawClearLineages(address, signMessageAsync, (m) =>
      onProgress({ phase: 'withdrawing', done: 0, total: 1, message: m }))
  } catch (e) {
    result.errors.push({ receipt: null, error: errMsg(e) })
  }

  onProgress({ phase: 'done', done: 1, total: 1, message: 'Done.' })
  return result
}

/**
 * Close ONE filled position: credit immediately if the SOLD attestation already exists, else submit a
 * market SELL and poll finalizeClose until it credits or the window elapses. On timeout the FAK is
 * considered killed — clear the marker and leave the position open (dust-preserved by the withdraw step).
 */
async function closePositionFull(
  address: `0x${string}`,
  receipt: Note,
  vaultAddress: `0x${string}`,
  signMessageAsync: SignFn,
  onMsg: (m: string) => void,
): Promise<{ done: boolean; reason: string }> {
  const nob = (receipt.nullifier_of_bet ?? receipt.nullifier) as `0x${string}`

  let res = await finalizeClose(address, receipt, vaultAddress, signMessageAsync)
  if (res.done) return { done: true, reason: 'closed' }
  if (res.reason === 'no-free-note') return { done: false, reason: 'no-free-note' }

  onMsg('Selling your position on Polymarket…')
  await submitMarketClose(address, receipt, vaultAddress) // idempotent (skips if already in flight)
  for (let i = 0; i < SOLD_POLL_MAX; i++) {
    await new Promise((r) => setTimeout(r, SOLD_POLL_MS))
    res = await finalizeClose(address, receipt, vaultAddress, signMessageAsync)
    if (res.done) return { done: true, reason: 'closed' }
    if (res.reason === 'no-free-note') return { done: false, reason: 'no-free-note' }
  }
  // No fill in the window → the market (FAK) sell was killed (it never rests). Drop the marker.
  clearCloseMarker(address, nob)
  return { done: false, reason: 'close-timeout' }
}

/**
 * Withdraw the full balance of every CLEAR lineage (no open position) to the wallet, in
 * <= MAX_CONSOLIDATE_INPUTS-note chunks until none remain. Lineages that still hold an open position
 * (a timed-out close, etc.) are LEFT FULLY INTACT — never touched here — so a residual position is
 * never stranded; the user withdraws those after the position clears. Returns the total withdrawn.
 */
async function withdrawClearLineages(
  address: `0x${string}`,
  signMessageAsync: SignFn,
  onMsg: (m: string) => void,
): Promise<bigint> {
  let total = 0n
  const sortDesc = (notes: Note[]) => notes.slice().sort((a, b) => (a.balance > b.balance ? -1 : 1))
  const topNsum = (notes: Note[], k: number) => sortDesc(notes).slice(0, k).reduce((s, n) => s + n.balance, 0n)

  for (let iter = 0; iter < 16; iter++) {
    await reconcileSpentStatus(address).catch(() => undefined)
    const openDeposits = new Set(getOpenBetReceipts(address).map((r) => r.depositIndex))
    const clearNotes = getFreeNotes(address).filter((n) => !openDeposits.has(n.depositIndex))
    if (clearNotes.length === 0) break

    const chunkTarget = topNsum(clearNotes, MAX_CONSOLIDATE_INPUTS)
    if (chunkTarget <= 0n) break

    let spendNote = sortDesc(clearNotes)[0]
    if (chunkTarget > spendNote.balance) {
      const sel = selectNotesForAmount(address, chunkTarget, {
        openPositionDeposits: openDeposits,
        preferredSlot0DepositIndex: spendNote.depositIndex,
      })
      if (sel.ok) {
        onMsg('Merging notes…')
        try {
          spendNote = await consolidateNotes({
            wallet: address,
            signMessageAsync,
            notes: sel.selection.notes,
            onProgress: onMsg,
          })
        } catch {
          // Merge failed — fall back to draining the single largest clear note this iteration.
        }
      }
    }

    // CLEAR lineage → no open position → a true full drain (new_commitment = 0).
    const ok = await withdrawOneNote(address, spendNote, spendNote.balance, signMessageAsync, onMsg)
    if (!ok) break // below-min remainder or relay error → stop; leftover stays withdrawable later
    total += spendNote.balance
  }
  return total
}

/** Build + relay a withdrawal of `amount` from one note. Returns false on a below-min / relay error. */
async function withdrawOneNote(
  address: `0x${string}`,
  spendNote: Note,
  amount: bigint,
  signMessageAsync: SignFn,
  onMsg: (m: string) => void,
): Promise<boolean> {
  if (amount <= 0n) return false
  try {
    const recipient = address
    const recipientField = `0x${BigInt(recipient).toString(16).padStart(64, '0')}` as `0x${string}`
    const recipientHash = computeRecipientHash(recipient)
    const secret = await getNoteSecret(signMessageAsync, address, spendNote.depositIndex, spendNote.derivationVersion ?? 1)
    onMsg('Fetching Merkle path…')
    const merkle = await fetchMerklePath(spendNote.commitment, {
      onWait: () => onMsg('Waiting for the network to index your note…'),
    })
    const remaining = spendNote.balance - amount
    const nextNonce = spendNote.nonce + 1n
    const newCommitment = remaining > 0n ? computeCommitment(secret, remaining, nextNonce, address) : ZERO_COMMITMENT

    onMsg('Generating withdrawal proof…')
    const { proof } = await generateProofInWorker({
      type: 'withdrawal',
      inputs: {
        secret,
        final_balance: spendNote.balance,
        nonce: spendNote.nonce,
        merkle_path: merkle.path,
        merkle_path_indices: merkle.pathIndices,
        owner_address: address,
        recipient_address: recipientField,
        merkle_root: merkle.root,
        nullifier: spendNote.nullifier,
        withdrawal_amount: amount,
        recipient_hash: recipientHash,
        new_commitment: newCommitment,
      },
    })

    onMsg('Submitting withdrawal…')
    const { txHash } = await relayWithdrawal(
      proof,
      {
        merkle_root: merkle.root,
        nullifier: spendNote.nullifier,
        withdrawal_amount: amount.toString(),
        recipient_hash: recipientHash,
        new_commitment: newCommitment,
      },
      recipient,
    )
    await waitForTransactionConfirmation(txHash as `0x${string}`)

    markNoteSpent(spendNote.commitment)
    recordWalletActivity({
      id: `withdrawal-${txHash}`,
      wallet: address,
      kind: 'withdrawal',
      amount,
      createdAt: Date.now(),
      txHash,
      destination: recipient,
    })
    if (remaining > 0n) {
      addNote({
        id: newCommitment,
        kind: 'BET_OUTPUT',
        owner_address: address,
        depositIndex: spendNote.depositIndex,
        balance: remaining,
        nonce: nextNonce,
        commitment: newCommitment,
        nullifier: computeNullifier(secret, nextNonce),
        spent: false,
        createdAt: Date.now(),
        txHash,
        derivationVersion: spendNote.derivationVersion ?? 1,
      })
    }
    return true
  } catch {
    return false
  }
}
