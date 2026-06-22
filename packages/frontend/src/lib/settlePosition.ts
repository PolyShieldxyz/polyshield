/**
 * Settle ONE resolved bet — extracted from SettlementModal.runSettlement so the same code path runs
 * from the modal, the portfolio, and the Settle-&-Withdraw orchestration (Option D).
 *
 * Spends the lineage's current free note (the SAME deposit as the bet receipt, so the secret matches
 * the settlement_credit constraint nullifier_of_bet = Poseidon2(secret, bet_nonce)) and continues it
 * with the credited balance. Idempotent: a bet already CREDITED on-chain retires the local receipt and
 * returns done. Returns { done:false, reason:'no-free-note' } when the lineage has no spendable note
 * (under Option A it always retains at least a dust tip). Throws only on a hard proof/relay failure
 * (caller may swallow). Mirrors lib/finalizeClose.ts.
 */

import {
  BET_STATUS,
  fetchAttestation,
  fetchBetRecord,
  fetchMerklePath,
  relaySettlement,
  waitForTransactionConfirmation,
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
  type ReadyToSettleBet,
} from './notes'
import { getNoteSecret } from './secretSession'
import { generateProofInWorker } from './prover'

const ZERO_BYTES32 = `0x${'00'.repeat(32)}` as `0x${string}`

export async function settlePosition(
  address: `0x${string}`,
  bet: ReadyToSettleBet,
  vaultAddress: string,
  signMessageAsync: (args: { message: string }) => Promise<`0x${string}`>,
): Promise<{ done: boolean; credited: bigint; nextNote: Note | null; reason?: 'no-free-note' }> {
  const receipt = bet.receipt
  const nullifierOfBet = (receipt.nullifier_of_bet ?? receipt.nullifier) as `0x${string}`

  // Idempotency: a bet already settled on-chain (this run, a prior poll, or another device) is DONE —
  // retire the local receipt so it stops showing "ready" and never double-spends a note against it.
  const rec = await fetchBetRecord(vaultAddress, nullifierOfBet)
  if (rec.status === BET_STATUS.CREDITED) {
    markBetReceiptSpent(nullifierOfBet)
    return { done: true, credited: 0n, nextNote: null }
  }

  // The credit MUST land on a note from the SAME deposit lineage as the bet (settlement_credit derives
  // nullifier_of_bet = Poseidon2(secret, bet_nonce) from this note's secret, requiring bet_nonce < nonce).
  const freeNote = getFreeNoteForDeposit(address, receipt.depositIndex)
  if (!freeNote) return { done: false, credited: 0n, nextNote: null, reason: 'no-free-note' }

  const secret = await getNoteSecret(signMessageAsync, address, freeNote.depositIndex, freeNote.derivationVersion ?? 1)
  const merkle = await fetchMerklePath(freeNote.commitment)
  const marketIdField = receipt.condition_id ?? ZERO_BYTES32
  const newNonce = freeNote.nonce + 1n
  const newBalance = freeNote.balance + bet.claimAmount
  const newCommitment = computeCommitment(secret, newBalance, newNonce, address)
  const newNullifier = computeNullifier(secret, newNonce)

  // PERF: prove in the terminating Web Worker so the snarkjs WASM heap is freed after each settlement.
  const { proof } = await generateProofInWorker({
    type: 'settlement',
    inputs: {
      secret,
      balance_before_credit: freeNote.balance,
      nonce: freeNote.nonce,
      // bet_nonce is the nonce of the note spent at bet-auth time, stored on the receipt — lets us
      // settle any open bet regardless of how many later actions occurred on this deposit chain.
      bet_nonce: receipt.nonce,
      merkle_path: merkle.path,
      merkle_path_indices: merkle.pathIndices,
      owner_address: address,
      merkle_root: merkle.root,
      nullifier: freeNote.nullifier,
      new_commitment: newCommitment,
      nullifier_of_bet: nullifierOfBet,
      market_id: marketIdField,
      total_credit: bet.claimAmount,
    },
  })

  // FC-9: a full-fill bet is ACTIVE on-chain and needs the operator's FILLED attestation; a post-partial
  // bet is already FILLED and ignores it. Pass whatever the operator signed.
  const settleAtt = await fetchAttestation(nullifierOfBet)
  const { txHash } = await relaySettlement(
    proof,
    {
      merkle_root: merkle.root,
      nullifier: freeNote.nullifier,
      new_commitment: newCommitment,
      nullifier_of_bet: nullifierOfBet,
      market_id: marketIdField,
      total_credit: bet.claimAmount.toString(),
    },
    settleAtt ?? undefined,
  )
  await waitForTransactionConfirmation(txHash as `0x${string}`)

  markNoteSpent(freeNote.commitment)
  markBetReceiptSpent(nullifierOfBet)
  recordWalletActivity({
    id: `settlement-${txHash}-${receipt.id}`,
    wallet: address,
    kind: 'settlement',
    amount: bet.claimAmount,
    createdAt: Date.now(),
    txHash,
    marketId: receipt.marketId as `0x${string}` | undefined,
    receiptId: receipt.id,
    receiptNullifier: nullifierOfBet,
    payout: bet.claimAmount,
  })

  const nextNote: Note = {
    id: newCommitment,
    kind: 'SETTLE_CREDIT',
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
    condition_id: marketIdField,
    derivationVersion: freeNote.derivationVersion ?? 1, // FC-13: inherit lineage version
  }
  addNote(nextNote)
  return { done: true, credited: bet.claimAmount, nextNote }
}
