'use client'

import { useEffect, useState } from 'react'
import { useSignMessage } from 'wagmi'
import { Modal } from '@/components/app/Modal'
import { KV } from '@/components/app/KV'
import {
  addNote,
  computeCommitment,
  computeNullifier,
  deriveSecret,
  formatUsdc,
  getSpendableNotes,
  markNoteSpent,
  recordWalletActivity,
  replaceNote,
  type Note,
} from '@/lib/notes'
import {
  fetchAttestation,
  fetchBetRecord,
  fetchMerklePath,
  relayPartialCredit,
  waitForTransactionConfirmation,
  type SignedAttestation,
} from '@/lib/api'
import { generateProofInWorker } from '@/lib/prover'

const REPORT_PARTIAL = 3

type Phase = 'input' | 'proving' | 'done' | 'error'

interface PartialFillCreditModalProps {
  open: boolean
  address: `0x${string}`
  receipt: Note // a BET_RECEIPT note that the operator reported as PARTIAL_FILLED
  vaultAddress: string
  onClose: () => void
  onComplete: () => Promise<void> | void
}

export function PartialFillCreditModal({
  open,
  address,
  receipt,
  vaultAddress,
  onClose,
  onComplete,
}: PartialFillCreditModalProps) {
  const { signMessageAsync } = useSignMessage()
  const [phase, setPhase] = useState<Phase>('input')
  const [error, setError] = useState<string | null>(null)
  // FC-9: figures come from the operator's off-chain PARTIAL attestation (filled/spent) plus
  // the on-chain bet_amount (set by authorizeBet). refund = betAmount - spentAmount.
  const [betAmount, setBetAmount] = useState<bigint>(0n)
  const [spentAmount, setSpentAmount] = useState<bigint>(0n)
  const [filledShares, setFilledShares] = useState<bigint>(0n)
  const [attestation, setAttestation] = useState<SignedAttestation | null>(null)
  const [loading, setLoading] = useState(true)

  const refundAmount = betAmount > spentAmount ? betAmount - spentAmount : 0n
  const nullifierOfBet = (receipt.nullifier_of_bet ?? receipt.nullifier) as `0x${string}`

  useEffect(() => {
    if (!open) return
    setPhase('input')
    setError(null)
    setLoading(true)
    void import('@/lib/prover').then(({ initProver }) => initProver())
    void (async () => {
      try {
        const att = await fetchAttestation(nullifierOfBet)
        if (!att || att.reportType !== REPORT_PARTIAL) {
          setError('No partial-fill attestation is available for this position yet. The operator signs it once the limit order ends partially filled.')
          setPhase('error')
          return
        }
        const rec = await fetchBetRecord(vaultAddress, nullifierOfBet)
        setAttestation(att)
        setBetAmount(rec.betAmount)
        setSpentAmount(BigInt(att.amountB))
        setFilledShares(BigInt(att.amountA))
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setPhase('error')
      } finally {
        setLoading(false)
      }
    })()
  }, [open, receipt, vaultAddress, nullifierOfBet])

  useEffect(() => {
    if (phase !== 'done') return
    const id = window.setTimeout(() => { void onComplete(); onClose() }, 5_000)
    return () => window.clearTimeout(id)
  }, [phase, onClose, onComplete])

  const run = async () => {
    setError(null)
    try {
      // partial_credit mirrors bet_cancel: it spends the immediate post-bet note
      // (the BET_OUTPUT note whose nonce = receipt.nonce + 1) because the circuit
      // derives nullifier_of_bet = Poseidon2(secret, nonce - 1). It is NOT an
      // arbitrary cash note.
      const outputNote = getSpendableNotes(address).find(
        (n) => n.depositIndex === receipt.depositIndex && n.nonce === receipt.nonce + 1n,
      )
      if (!outputNote) {
        throw new Error(
          'The post-bet note for this position is unavailable (already spent on a later action). ' +
          'Partial-fill refund requires the original post-bet note.',
        )
      }
      if (refundAmount <= 0n) {
        throw new Error('Nothing to refund — the order filled completely.')
      }

      setPhase('proving')
      const secret = await deriveSecret(signMessageAsync, address, outputNote.depositIndex)
      const merkle = await fetchMerklePath(outputNote.commitment)
      const newNonce = outputNote.nonce + 1n
      const newBalance = outputNote.balance + refundAmount
      const newCommitment = computeCommitment(secret, newBalance, newNonce, address)
      const newNullifier = computeNullifier(secret, newNonce)

      const { proof } = await generateProofInWorker({
        type: 'partial_credit',
        inputs: {
          secret,
          current_balance: outputNote.balance,
          nonce: outputNote.nonce,
          merkle_path: merkle.path,
          merkle_path_indices: merkle.pathIndices,
          owner_address: address,
          merkle_root: merkle.root,
          nullifier: outputNote.nullifier,
          new_commitment: newCommitment,
          nullifier_of_bet: nullifierOfBet,
          refund_amount: refundAmount,
        },
      })

      const { txHash } = await relayPartialCredit(proof, {
        merkle_root: merkle.root,
        nullifier: outputNote.nullifier,
        new_commitment: newCommitment,
        nullifier_of_bet: nullifierOfBet,
      }, attestation ?? undefined)
      await waitForTransactionConfirmation(txHash as `0x${string}`)

      markNoteSpent(outputNote.commitment)
      addNote({
        id: newCommitment,
        kind: 'CANCEL_CREDIT',
        owner_address: address,
        depositIndex: outputNote.depositIndex,
        balance: newBalance,
        nonce: newNonce,
        commitment: newCommitment,
        nullifier: newNullifier,
        spent: false,
        createdAt: Date.now(),
        txHash,
        marketId: receipt.marketId,
        condition_id: receipt.condition_id,
      })
      // The Vault normalized the bet record to FILLED with reduced shares/amount.
      // Mirror that on the open receipt so it can still be settled/closed later.
      replaceNote(receipt.id, {
        ...receipt,
        bet_amount: spentAmount,
        expectedShares: filledShares,
      })
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

      setPhase('done')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase('error')
    }
  }

  return (
    <Modal open={open} title="Claim partial-fill refund" onClose={() => { if (phase !== 'proving') onClose() }}>
      {phase === 'input' && (
        <div className="col gap-4">
          <p className="body" style={{ margin: 0 }}>
            Your limit order filled only partially before it ended. Reclaim the unfilled
            remainder of your stake back to your private balance. Your remaining filled
            position stays open and can be settled or closed later.
          </p>
          <div className="panel" style={{ padding: 16 }}>
            <KV l="Market" v={receipt.marketId ?? receipt.id} />
            <KV l="Original stake" v={loading ? '…' : `$${formatUsdc(betAmount)}`} />
            <KV l="Filled (spent)" v={loading ? '…' : `$${formatUsdc(spentAmount)}`} />
            <KV l="Filled shares" v={loading ? '…' : (Number(filledShares) / 1e6).toFixed(2)} />
            <KV l="Refund (unfilled)" v={loading ? '…' : `$${formatUsdc(refundAmount)} USDC`} />
          </div>
          <div className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={loading || refundAmount <= 0n} onClick={() => void run()}>
              Claim ${formatUsdc(refundAmount)}
            </button>
          </div>
        </div>
      )}

      {phase === 'proving' && (
        <div className="col gap-4">
          <div className="micro">GENERATING REFUND PROOF</div>
          <h3 className="h4" style={{ margin: 0 }}>Crediting the unfilled remainder back to your note…</h3>
          <p className="small" style={{ margin: 0 }}>Do not close this window.</p>
        </div>
      )}

      {phase === 'done' && (
        <div className="col gap-4">
          <div className="micro" style={{ color: 'var(--green)' }}>REFUND CREDITED</div>
          <h3 className="h4" style={{ margin: 0 }}>+${formatUsdc(refundAmount)} returned to your balance.</h3>
          <p className="small" style={{ margin: 0 }}>Auto close in 5 seconds.</p>
        </div>
      )}

      {phase === 'error' && (
        <div className="col gap-4">
          <div className="micro" style={{ color: 'var(--red)' }}>REFUND FAILED</div>
          {error && <p className="body" style={{ margin: 0 }}>{error}</p>}
          <div className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
            <button className="btn" onClick={onClose}>Close</button>
            <button className="btn btn-primary" onClick={() => void run()}>Retry</button>
          </div>
        </div>
      )}
    </Modal>
  )
}
