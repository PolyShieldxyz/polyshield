/**
 * FC-14: silent auto-finalize of a partially-filled bet.
 *
 * Every market buy is a "partial" relative to the fee-naive committed `expected_shares` (the
 * Polymarket taker fee eats part of the stake), so the operator signs a PARTIAL attestation and the
 * on-chain record stays ACTIVE with an inflated `expected_shares` until `partialFillCredit` normalizes
 * it to the true fill. That normalization is mandatory before the bet can settle (otherwise settlement
 * over-credits the shared pool). This helper runs it automatically and invisibly — the proof is built
 * with the in-memory V2 master seed (no wallet prompt) and relayed (no wallet tx) — so a normal fill
 * just becomes "Filled — N shares" with no confusing "$0 reclaim" chore.
 *
 * Returns true if it finalized a bet; false if there was nothing to do or a prerequisite was missing
 * (caller stays silent). Throws only on a hard relay/proof failure (caller may swallow).
 */

import {
  fetchAttestation,
  fetchBetRecord,
  fetchBetProtocolFee,
  fetchMerklePath,
  relayPartialCredit,
  waitForTransactionConfirmation,
} from './api'
import {
  getFreeNoteForDeposit,
  addNote,
  markNoteSpent,
  replaceNote,
  recordWalletActivity,
  computeCommitment,
  computeNullifier,
  type Note,
} from './notes'
import { getNoteSecret } from './secretSession'
import { generateProofInWorker } from './prover'

const REPORT_PARTIAL = 3
const STATUS_ACTIVE = 0 // BetStatus.ACTIVE — only an un-normalized record is creditable

export async function finalizePartialFill(
  address: `0x${string}`,
  receipt: Note,
  vaultAddress: `0x${string}`,
  signMessageAsync: (args: { message: string }) => Promise<`0x${string}`>,
): Promise<boolean> {
  const nullifierOfBet = (receipt.nullifier_of_bet ?? receipt.nullifier) as `0x${string}`

  const att = await fetchAttestation(nullifierOfBet)
  if (!att || att.reportType !== REPORT_PARTIAL) return false
  const rec = await fetchBetRecord(vaultAddress, nullifierOfBet)
  if (rec.status !== STATUS_ACTIVE) return false // already normalized/terminal
  const freeNote = getFreeNoteForDeposit(address, receipt.depositIndex)
  if (!freeNote) return false

  const betAmount = rec.betAmount
  const spentAmount = BigInt(att.amountB)
  const filledShares = BigInt(att.amountA)
  const protocolFee = await fetchBetProtocolFee(vaultAddress, nullifierOfBet)

  // Mirror the Vault's injected refund EXACTLY (floor math): unfilled stake + pro-rata protocol fee.
  const unexec = betAmount > spentAmount ? betAmount - spentAmount : 0n
  const refundAmount = unexec > 0n && betAmount > 0n ? unexec + (protocolFee * unexec) / betAmount : 0n

  const secret = await getNoteSecret(signMessageAsync, address, freeNote.depositIndex, freeNote.derivationVersion ?? 1)
  const merkle = await fetchMerklePath(freeNote.commitment)
  const newNonce = freeNote.nonce + 1n
  const newBalance = freeNote.balance + refundAmount
  const newCommitment = computeCommitment(secret, newBalance, newNonce, address)
  const newNullifier = computeNullifier(secret, newNonce)

  const { proof } = await generateProofInWorker({
    type: 'partial_credit',
    inputs: {
      secret,
      current_balance: freeNote.balance,
      nonce: freeNote.nonce,
      merkle_path: merkle.path,
      merkle_path_indices: merkle.pathIndices,
      owner_address: address,
      bet_nonce: receipt.nonce,
      merkle_root: merkle.root,
      nullifier: freeNote.nullifier,
      new_commitment: newCommitment,
      nullifier_of_bet: nullifierOfBet,
      refund_amount: refundAmount,
    },
  })

  const { txHash } = await relayPartialCredit(
    proof,
    { merkle_root: merkle.root, nullifier: freeNote.nullifier, new_commitment: newCommitment, nullifier_of_bet: nullifierOfBet },
    att ?? undefined,
  )
  await waitForTransactionConfirmation(txHash as `0x${string}`)

  // Spend the free note, continue the lineage (refund credited, or carried at the same balance on a
  // fee-only fill), and normalize the receipt to the actual fill so it stays settleable.
  markNoteSpent(freeNote.commitment)
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
    derivationVersion: freeNote.derivationVersion ?? 1,
  })
  replaceNote(receipt.id, { ...receipt, bet_amount: spentAmount, expectedShares: filledShares })
  // Only a genuine partial (real unfilled remainder) is a capital return worth showing; a fee-only
  // fill refunds 0 and should not clutter the activity feed.
  if (refundAmount > 0n) {
    recordWalletActivity({
      id: `partial-${txHash}-${receipt.id}`,
      wallet: address,
      kind: 'refund',
      amount: refundAmount,
      createdAt: Date.now(),
      txHash,
      marketId: receipt.marketId as `0x${string}` | undefined,
      receiptId: receipt.id,
      receiptNullifier: nullifierOfBet,
      payout: refundAmount,
    })
  }
  return true
}
