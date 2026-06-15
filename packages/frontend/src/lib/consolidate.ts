/**
 * FC-8: client-side note consolidation orchestration.
 *
 * Merges up to 4 same-owner notes into one (a `consolidate` ZK proof + a single
 * Vault tx via the proof relay), so a bet/withdrawal that exceeds any single note's
 * balance can be done after a one-step merge. Pure value-preserving: no token movement.
 *
 * The merged note continues the LARGEST input note's lineage (slot 0): its secret and
 * nonce+1, with the summed balance. The other inputs' lineages end (nullifiers spent).
 */

import {
  type Note,
  MAX_CONSOLIDATE_INPUTS,
  computeCommitment,
  computeNullifier,
  addNote,
  markNoteSpent,
} from './notes'
import { getNoteSecret } from './secretSession'
import {
  fetchMerklePath,
  relayConsolidate,
  waitForTransactionConfirmation,
} from './api'
import { generateProofInWorker } from './prover'

const ZERO_HEX32 = `0x${'00'.repeat(32)}` as `0x${string}`
const ZERO_PATH = Array<string>(32).fill('0')

export interface ConsolidateParams {
  wallet: `0x${string}`
  signMessageAsync: (args: { message: string }) => Promise<`0x${string}`>
  /** Selected free notes (largest first; index 0 anchors the merged lineage). 2–4 entries. */
  notes: Note[]
  /** Optional progress callback for UI ("merging notes…"). */
  onProgress?: (msg: string) => void
}

/**
 * Build + relay a consolidate proof for the selected notes, then update local note
 * state (mark inputs spent, add the merged note). Returns the merged note, ready to
 * be spent by a normal single-input bet/withdrawal.
 */
export async function consolidateNotes(params: ConsolidateParams): Promise<Note> {
  const { wallet, signMessageAsync, notes, onProgress } = params
  if (notes.length < 2) throw new Error('consolidateNotes requires at least 2 notes')
  if (notes.length > MAX_CONSOLIDATE_INPUTS) throw new Error(`consolidateNotes accepts at most ${MAX_CONSOLIDATE_INPUTS} notes`)

  onProgress?.('Preparing note merge…')

  // Per-note: derive its secret (by deposit index) and fetch its Merkle path.
  const secrets: `0x${string}`[] = []
  const paths: { path: string[]; pathIndices: number[]; root: string }[] = []
  for (const n of notes) {
    secrets.push(await getNoteSecret(signMessageAsync, wallet, n.depositIndex, n.derivationVersion ?? 1))
    paths.push(await fetchMerklePath(n.commitment))
  }
  // All active notes prove against the same (current) root.
  const merkleRoot = paths[0].root

  // Pad arrays to K=4. Slot 0 is the largest note (anchors the merged lineage).
  const K = MAX_CONSOLIDATE_INPUTS
  const secretArr: string[] = []
  const balanceArr: bigint[] = []
  const nonceArr: bigint[] = []
  const pathArr: string[][] = []
  const pathIdxArr: number[][] = []
  const isActive: number[] = []
  const nullifierArr: string[] = []

  for (let j = 0; j < K; j++) {
    if (j < notes.length) {
      secretArr.push(secrets[j])
      balanceArr.push(notes[j].balance)
      nonceArr.push(notes[j].nonce)
      pathArr.push(paths[j].path)
      pathIdxArr.push(paths[j].pathIndices)
      isActive.push(1)
      nullifierArr.push(computeNullifier(secrets[j], notes[j].nonce))
    } else {
      // Inactive padding slot: zero everything; the circuit gates these out.
      secretArr.push('0')
      balanceArr.push(0n)
      nonceArr.push(0n)
      pathArr.push([...ZERO_PATH])
      pathIdxArr.push(ZERO_PATH.map(() => 0))
      isActive.push(0)
      nullifierArr.push(ZERO_HEX32)
    }
  }

  // Merged note continues slot 0's lineage: (secret0, sum, nonce0+1, owner).
  const sum = notes.reduce((s, n) => s + n.balance, 0n)
  const mergedNonce = notes[0].nonce + 1n
  const mergedCommitment = computeCommitment(secrets[0], sum, mergedNonce, wallet)
  const mergedNullifier = computeNullifier(secrets[0], mergedNonce)

  onProgress?.('Generating merge proof…')
  const { proof } = await generateProofInWorker({
    type: 'consolidate',
    inputs: {
      secret: secretArr,
      balance: balanceArr,
      nonce: nonceArr,
      merkle_path: pathArr,
      merkle_path_indices: pathIdxArr,
      is_active: isActive,
      owner_address: wallet,
      merkle_root: merkleRoot,
      nullifier: nullifierArr,
      new_commitment: mergedCommitment,
    },
  })

  onProgress?.('Submitting merge…')
  const { txHash } = await relayConsolidate(proof, {
    merkle_root: merkleRoot,
    nullifiers: nullifierArr,
    new_commitment: mergedCommitment,
  })
  await waitForTransactionConfirmation(txHash as `0x${string}`)

  // Local bookkeeping: spend the inputs, add the merged note.
  for (const n of notes) markNoteSpent(n.commitment)
  const merged: Note = {
    id: mergedCommitment,
    kind: 'BET_OUTPUT',
    owner_address: wallet,
    depositIndex: notes[0].depositIndex,
    balance: sum,
    nonce: mergedNonce,
    commitment: mergedCommitment,
    nullifier: mergedNullifier,
    spent: false,
    createdAt: Date.now(),
    txHash,
    derivationVersion: notes[0].derivationVersion ?? 1, // FC-13: merged note continues slot 0's lineage
  }
  addNote(merged)
  return merged
}
