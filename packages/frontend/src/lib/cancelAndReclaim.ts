/**
 * Cancel a live/stuck order and reclaim its stake — the orchestration primitive (Option D) for RESTING
 * limit orders, never-filled (unfilled-resolved) orders, and stuck pending bets. Composes the backend
 * cancel (cancelPendingBet) with the EXISTING credit math: a FAILED attestation → full bet_cancel
 * reclaim (mirrors BetCancelRefundModal: refund = bet_amount + protocolFee), a PARTIAL attestation →
 * finalizePartialFill (normalizes the record, leaving the filled remainder OPEN for the close phase).
 *
 * Idempotent and best-effort: returns { done:false, reason:'still-resting' } when the operator hasn't
 * produced a terminal attestation in the poll window, so the orchestrator leaves the position
 * (dust-preserved) and moves on. Only the cancel→poll→credit orchestration is new; the credit math is
 * reused verbatim so FC-14 fee/refund behavior stays identical to the modal paths.
 */

import {
  BET_STATUS,
  cancelPendingBet,
  fetchAttestation,
  fetchBetProtocolFee,
  fetchBetRecord,
  fetchMerklePath,
  relayBetCancel,
  waitForTransactionConfirmation,
  type SignedAttestation,
} from './api'
import {
  addNote,
  computeCommitment,
  computeNullifier,
  getFreeNoteForDeposit,
  markBetReceiptSpent,
  markNoteSpent,
  recordWalletActivity,
  type Note,
} from './notes'
import { getNoteSecret } from './secretSession'
import { finalizePartialFill } from './finalizePartial'
import { generateProofInWorker } from './prover'

const REPORT_FAILED = 2
const REPORT_PARTIAL = 3

type SignFn = (args: { message: string }) => Promise<`0x${string}`>

export type ReclaimResult = {
  done: boolean
  reclaimed: bigint
  reason?: 'still-resting' | 'no-free-note' | 'partial-normalized'
}

export async function reclaimBet(
  address: `0x${string}`,
  receipt: Note,
  vaultAddress: string,
  signMessageAsync: SignFn,
): Promise<ReclaimResult> {
  const nullifierOfBet = (receipt.nullifier_of_bet ?? receipt.nullifier) as `0x${string}`

  // Idempotency: already reclaimed/credited on-chain → retire the receipt and finish.
  const rec0 = await fetchBetRecord(vaultAddress, nullifierOfBet)
  if (
    rec0.status === BET_STATUS.CANCELLED_CREDITED ||
    rec0.status === BET_STATUS.CREDITED ||
    rec0.status === BET_STATUS.CLOSED_CREDITED
  ) {
    markBetReceiptSpent(nullifierOfBet)
    return { done: true, reclaimed: 0n }
  }

  // 1) A terminal attestation may already exist — credit it without re-cancelling.
  let result = await tryCreditFromAttestation(address, receipt, vaultAddress, signMessageAsync)
  if (result) return result

  // 2) Ask the operator to cancel/recover the order, then poll for the resulting attestation.
  try {
    await cancelPendingBet(nullifierOfBet)
  } catch {
    /* best-effort — the poll below decides whether anything is reclaimable */
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise((r) => setTimeout(r, 2_500))
    result = await tryCreditFromAttestation(address, receipt, vaultAddress, signMessageAsync)
    if (result) return result
  }
  // No terminal attestation in the window — the order is still working. Leave it (dust-preserved).
  return { done: false, reclaimed: 0n, reason: 'still-resting' }
}

/** Acts on a terminal bet-outcome attestation if present; returns null when none exists yet. */
async function tryCreditFromAttestation(
  address: `0x${string}`,
  receipt: Note,
  vaultAddress: string,
  signMessageAsync: SignFn,
): Promise<ReclaimResult | null> {
  const nullifierOfBet = (receipt.nullifier_of_bet ?? receipt.nullifier) as `0x${string}`
  const att = await fetchAttestation(nullifierOfBet) // bet-outcome attestation (FILLED/FAILED/PARTIAL)
  if (!att) return null
  if (att.reportType === REPORT_FAILED) {
    return creditFailedReclaim(address, receipt, vaultAddress, signMessageAsync, att)
  }
  if (att.reportType === REPORT_PARTIAL) {
    // Normalize (refund the unfilled remainder); the FILLED remainder stays OPEN and is closed by the
    // orchestration's close phase. Not a terminal reclaim of the whole bet.
    await finalizePartialFill(address, receipt, vaultAddress as `0x${string}`, signMessageAsync)
    return { done: false, reclaimed: 0n, reason: 'partial-normalized' }
  }
  return null // FILLED (or other) → a live position, handled by the close phase, not here
}

/** Full-stake reclaim for a FAILED order — mirrors BetCancelRefundModal.run (refund = bet_amount + fee). */
async function creditFailedReclaim(
  address: `0x${string}`,
  receipt: Note,
  vaultAddress: string,
  signMessageAsync: SignFn,
  attestation: SignedAttestation,
): Promise<ReclaimResult> {
  const nullifierOfBet = (receipt.nullifier_of_bet ?? receipt.nullifier) as `0x${string}`
  const freeNote = getFreeNoteForDeposit(address, receipt.depositIndex)
  if (!freeNote) return { done: false, reclaimed: 0n, reason: 'no-free-note' }

  const rec = await fetchBetRecord(vaultAddress, nullifierOfBet)
  const betAmount = rec.betAmount
  if (betAmount <= 0n) {
    markBetReceiptSpent(nullifierOfBet)
    return { done: true, reclaimed: 0n }
  }
  // FC-14: a never-executed bet refunds the protocol fee too (the Vault injects bet_amount + fee).
  const protocolFee = await fetchBetProtocolFee(vaultAddress, nullifierOfBet)
  const refundTotal = betAmount + protocolFee

  const secret = await getNoteSecret(signMessageAsync, address, freeNote.depositIndex, freeNote.derivationVersion ?? 1)
  const merkle = await fetchMerklePath(freeNote.commitment)
  const newNonce = freeNote.nonce + 1n
  const newBalance = freeNote.balance + refundTotal
  const newCommitment = computeCommitment(secret, newBalance, newNonce, address)
  const newNullifier = computeNullifier(secret, newNonce)

  const { proof } = await generateProofInWorker({
    type: 'bet_cancel',
    inputs: {
      secret,
      current_balance: freeNote.balance,
      nonce: freeNote.nonce,
      merkle_path: merkle.path,
      merkle_path_indices: merkle.pathIndices,
      owner_address: address,
      bet_nonce: receipt.nonce, // nonce of the note the bet was made from
      merkle_root: merkle.root,
      nullifier: freeNote.nullifier,
      new_commitment: newCommitment,
      nullifier_of_bet: nullifierOfBet,
      bet_amount: refundTotal, // FC-14: Vault-injected refund = bet_amount + protocolFee
    },
  })
  const { txHash } = await relayBetCancel(
    proof,
    { merkle_root: merkle.root, nullifier: freeNote.nullifier, new_commitment: newCommitment, nullifier_of_bet: nullifierOfBet },
    attestation ?? undefined,
  )
  await waitForTransactionConfirmation(txHash as `0x${string}`)

  markNoteSpent(freeNote.commitment)
  markBetReceiptSpent(nullifierOfBet)
  addNote({
    id: newCommitment,
    kind: 'CANCEL_CREDIT',
    owner_address: address,
    depositIndex: freeNote.depositIndex,
    balance: newBalance,
    nonce: newNonce,
    commitment: newCommitment,
    nullifier: newNullifier,
    spent: false,
    createdAt: Date.now(),
    txHash,
    marketId: receipt.marketId,
    condition_id: receipt.condition_id,
    derivationVersion: freeNote.derivationVersion ?? 1, // FC-13: inherit lineage version
  })
  recordWalletActivity({
    id: `betcancel-${txHash}-${receipt.id}`,
    wallet: address,
    kind: 'refund',
    amount: refundTotal,
    createdAt: Date.now(),
    txHash,
    marketId: receipt.marketId as `0x${string}` | undefined,
    receiptId: receipt.id,
    receiptNullifier: nullifierOfBet,
    payout: refundTotal,
  })
  return { done: true, reclaimed: refundTotal }
}
