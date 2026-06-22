/**
 * Background finalization of a position close.
 *
 * A close has two halves: (1) submit the SELL to Polymarket (fast), and (2) once the operator signs
 * the SOLD attestation (reportType 4 — happens when the SELL fills, which for a LIMIT close can be
 * much later), build the `position_close` proof and credit the proceeds into a note. This helper is
 * half (2), factored out of ClosePositionModal so it can run from THREE places against one code path:
 *   - the modal, for a market close that fills within its short wait;
 *   - the portfolio background poll, auto-crediting silently (V2 seed in memory, no prompt);
 *   - a manual "Credit proceeds" row action when the seed is locked (one signature).
 *
 * Mirrors lib/finalizePartial.ts. Returns { done:true } once the proceeds are credited (or were
 * already credited on-chain — idempotent); { done:false } if there's nothing to do yet (no SOLD
 * attestation, or no spendable note in this deposit chain), so the caller stays quiet and retries.
 * Throws only on a hard proof/relay failure (caller may swallow).
 */

import {
  fetchAttestation,
  fetchBetRecord,
  fetchMerklePath,
  relayClose,
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
} from './notes'
import { getNoteSecret } from './secretSession'
import { generateProofInWorker } from './prover'

const REPORT_SOLD = 4
const STATUS_CLOSED_CREDITED = 6 // BetStatus.CLOSED_CREDITED — a full close already credited on-chain

export async function finalizeClose(
  address: `0x${string}`,
  receipt: Note,
  vaultAddress: string,
  signMessageAsync: (args: { message: string }) => Promise<`0x${string}`>,
): Promise<{ done: boolean; proceeds: bigint; reason?: 'no-sold' | 'no-free-note' }> {
  const nullifierOfBet = (receipt.nullifier_of_bet ?? receipt.nullifier) as `0x${string}`

  // 1. On-chain status FIRST. A completed full close is CLOSED_CREDITED on-chain — credited by the
  // modal, a prior poll, or a different session/device. The position is DONE, so RETIRE the local
  // receipt (markBetReceiptSpent) so it stops showing as "open". This must precede the SOLD-attestation
  // check, because the attestation can be gone (store reset, old close) while the on-chain credit
  // stands — and the old code bailed on the missing attestation, leaving the position stuck open.
  const rec = await fetchBetRecord(vaultAddress, nullifierOfBet)
  if (rec.status === STATUS_CLOSED_CREDITED) {
    markBetReceiptSpent(nullifierOfBet)
    return { done: true, proceeds: rec.sellProceeds }
  }

  // 2. Not yet credited → we need the operator's SOLD attestation to build the credit proof. The
  // operator signs it once the SELL fills (fully or partially). Until then the order is still resting.
  const att = await fetchAttestation(nullifierOfBet, REPORT_SOLD)
  if (!att || att.reportType !== REPORT_SOLD) return { done: false, proceeds: 0n, reason: 'no-sold' }

  // 3. Need a spendable note from the SAME deposit chain as the receipt — the close circuit derives
  // nullifier_of_bet = Poseidon2(secret, bet_nonce) from this note's deposit index, so a note from a
  // different deposit would not verify. If none is free, the credit CANNOT land (the proceeds stay in
  // the pool) — surface it so the row doesn't spin "Crediting…" forever (the user needs a spendable
  // note in this deposit: a fresh deposit, or a free note from the same deposit lineage).
  const freeNote = getFreeNoteForDeposit(address, receipt.depositIndex)
  if (!freeNote) return { done: false, proceeds: 0n, reason: 'no-free-note' }

  const proceeds = BigInt(att.amountB) // Vault injects att.amountB as sell_proceeds

  // 4. Build the position_close proof and credit the proceeds into a continued note.
  const secret = await getNoteSecret(signMessageAsync, address, freeNote.depositIndex, freeNote.derivationVersion ?? 1)
  const merkle = await fetchMerklePath(freeNote.commitment)
  const newNonce = freeNote.nonce + 1n
  const newBalance = freeNote.balance + proceeds
  const newCommitment = computeCommitment(secret, newBalance, newNonce, address)
  const newNullifier = computeNullifier(secret, newNonce)

  // PERF-001: prove in the terminating Web Worker (which frees the snarkjs WASM heap on exit), NOT on
  // the main thread. This runs from the portfolio's UNATTENDED background poll, so a main-thread proof
  // here accumulated memory on every invocation (see prover.worker.ts header) — the 4.6 GB leak. Mirrors
  // lib/finalizePartial.ts, the sibling that already did this correctly.
  const { proof } = await generateProofInWorker({
    type: 'position_close',
    inputs: {
      secret,
      balance_before_credit: freeNote.balance,
      nonce: freeNote.nonce,
      bet_nonce: receipt.nonce,
      merkle_path: merkle.path,
      merkle_path_indices: merkle.pathIndices,
      owner_address: address,
      merkle_root: merkle.root,
      nullifier: freeNote.nullifier,
      new_commitment: newCommitment,
      nullifier_of_bet: nullifierOfBet,
      sell_proceeds: proceeds,
    },
  })

  const { txHash } = await relayClose(
    proof,
    { merkle_root: merkle.root, nullifier: freeNote.nullifier, new_commitment: newCommitment, nullifier_of_bet: nullifierOfBet },
    att,
  )
  await waitForTransactionConfirmation(txHash as `0x${string}`)

  // 5. Local state: spend the free note, continue the lineage with the credited note, retire the
  // receipt on a full close (a partial close keeps it — the unsold remainder settles at resolution).
  markNoteSpent(freeNote.commitment)
  const fullClose = BigInt(att.amountA) >= rec.expectedShares
  if (fullClose) markBetReceiptSpent(nullifierOfBet)
  recordWalletActivity({
    id: `close-${txHash}-${receipt.id}`,
    wallet: address,
    kind: 'settlement',
    amount: proceeds,
    createdAt: Date.now(),
    txHash,
    marketId: receipt.marketId as `0x${string}` | undefined,
    receiptId: receipt.id,
    receiptNullifier: nullifierOfBet,
    payout: proceeds,
  })
  const credited: Note = {
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
    condition_id: receipt.condition_id,
    derivationVersion: freeNote.derivationVersion ?? 1,
  }
  addNote(credited)
  return { done: true, proceeds }
}
