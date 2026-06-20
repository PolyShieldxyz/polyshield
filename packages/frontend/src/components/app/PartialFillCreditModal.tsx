'use client'

import { useEffect, useState } from 'react'
import { useSignMessage } from 'wagmi'
import { Modal } from '@/components/app/Modal'
import { KV } from '@/components/app/KV'
import { LiveRegion } from '@/components/app/LiveRegion'
import {
  addNote,
  computeCommitment,
  computeNullifier,
  formatUsdc,
  getFreeNoteForDeposit,
  markNoteSpent,
  recordWalletActivity,
  replaceNote,
  type Note,
} from '@/lib/notes'
import { getNoteSecret } from '@/lib/secretSession'
import {
  fetchAttestation,
  fetchBetRecord,
  fetchBetProtocolFee,
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
  // FC-14: refund includes the pro-rata protocol fee on the unexecuted portion (relay fee kept).
  const [protocolFee, setProtocolFee] = useState<bigint>(0n)
  const [attestation, setAttestation] = useState<SignedAttestation | null>(null)
  const [loading, setLoading] = useState(true)

  // FC-14: matches the Vault's injected refund exactly (floor math): unfilled stake + pro-rata fee.
  const unexecuted = betAmount > spentAmount ? betAmount - spentAmount : 0n
  const refundAmount =
    unexecuted > 0n && betAmount > 0n ? unexecuted + (protocolFee * unexecuted) / betAmount : 0n
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
        setProtocolFee(await fetchBetProtocolFee(vaultAddress, nullifierOfBet))
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
      // Decoupled refund: spend the CURRENT note in this bet's deposit lineage and bind the bet
      // via bet_nonce = receipt.nonce (circuit derives nullifier_of_bet = Poseidon2(secret,
      // bet_nonce)). No longer requires the immediate post-bet note, so a later action that
      // consumed it doesn't orphan the refund.
      const freeNote = getFreeNoteForDeposit(address, receipt.depositIndex)
      if (!freeNote) {
        throw new Error(
          'No spendable note found for this position. Recover your notes from chain (Portfolio → Restore) and retry.',
        )
      }
      // A $0 refund (full-budget short fill: the full stake was spent but fewer shares filled than
      // quoted) STILL requires this partialFillCredit call — it normalizes the bet record on-chain
      // (expected_shares := filled_shares, status := FILLED) so the position becomes settleable. The
      // Vault accepts refund_amount == 0 (L3 "B-relax"). Blocking it here strands the bet.
      setPhase('proving')
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
          bet_nonce: receipt.nonce, // nonce of the note the bet was made from
          merkle_root: merkle.root,
          nullifier: freeNote.nullifier,
          new_commitment: newCommitment,
          nullifier_of_bet: nullifierOfBet,
          refund_amount: refundAmount,
        },
      })

      const { txHash } = await relayPartialCredit(proof, {
        merkle_root: merkle.root,
        nullifier: freeNote.nullifier,
        new_commitment: newCommitment,
        nullifier_of_bet: nullifierOfBet,
      }, attestation ?? undefined)
      await waitForTransactionConfirmation(txHash as `0x${string}`)

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
        derivationVersion: freeNote.derivationVersion ?? 1, // FC-13: inherit lineage version
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

  // WCAG 4.1.3 — announce proof generation + the refunded result (the proof step is otherwise silent).
  const announce =
    phase === 'proving'
      ? 'Generating refund proof and crediting the unfilled remainder…'
      : phase === 'done'
        ? `Refund credited. $${formatUsdc(refundAmount)} returned to your balance.`
        : phase === 'error'
          ? error ?? 'Refund failed.'
          : ''

  return (
    <Modal open={open} title="Claim partial-fill refund" onClose={() => { if (phase !== 'proving') onClose() }}>
      <LiveRegion message={announce} assertive={phase === 'error'} />
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
            <button className="btn btn-primary" disabled={loading} onClick={() => void run()}>
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
