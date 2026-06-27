'use client'

import { useEffect, useState } from 'react'
import { useSignMessage } from 'wagmi'
import { Modal } from '@/components/app/Modal'
import { KV } from '@/components/app/KV'
import { LiveRegion } from '@/components/app/LiveRegion'
import { CreditCannotLand } from '@/components/app/CreditCannotLand'
import {
  addNote,
  computeCommitment,
  computeNullifier,
  formatUsdc,
  getFreeNoteForDeposit,
  markBetReceiptSpent,
  markNoteSpent,
  recordWalletActivity,
  type Note,
} from '@/lib/notes'
import { getNoteSecret } from '@/lib/secretSession'
import {
  fetchAttestation,
  fetchBetRecord,
  fetchBetProtocolFee,
  fetchMerklePath,
  relayBetCancel,
  waitForTransactionConfirmation,
  type SignedAttestation,
} from '@/lib/api'
import { generateProofInWorker } from '@/lib/prover'

// FC-9 operator report types. A market order that didn't fill, or an expired limit order, is
// attested FAILED; the depositor reclaims their FULL stake via betCancellationCredit.
const REPORT_FAILED = 2

// H3: getFreeNoteForDeposit returning null throws this; route it to the recoverable Restore screen.
const NO_FREE_NOTE_MSG =
  'No spendable note found for this bet. Recover your notes from chain (Portfolio → Restore) and retry.'
const isNoFreeNote = (m: string) => m === NO_FREE_NOTE_MSG || /no spendable note found/i.test(m)

type Phase = 'input' | 'proving' | 'done' | 'error' | 'cant-land'

interface BetCancelRefundModalProps {
  open: boolean
  address: `0x${string}`
  receipt: Note // a BET_RECEIPT note the operator reported FAILED (market no-fill or limit expiry)
  vaultAddress: string
  /** H3: parent's "Restore from chain" (re-derives notes). Required to recover a no-free-note credit. */
  onRestore?: () => void
  /** H3: spinner state for the Restore button (parent's `recovering`). */
  restoring?: boolean
  onClose: () => void
  onComplete: () => Promise<void> | void
}

/**
 * Reclaim the full stake of a bet whose order never filled — a market order that missed, or a
 * limit order that expired on the book. The operator signs a FAILED attestation; the
 * Vault's betCancellationCredit injects the original bet_amount and credits it back to a
 * fresh note. Mirrors PartialFillCreditModal but refunds the WHOLE stake and retires the
 * receipt (there is no remaining position).
 */
export function BetCancelRefundModal({
  open,
  address,
  receipt,
  vaultAddress,
  onRestore,
  restoring,
  onClose,
  onComplete,
}: BetCancelRefundModalProps) {
  const { signMessageAsync } = useSignMessage()
  const [phase, setPhase] = useState<Phase>('input')
  const [error, setError] = useState<string | null>(null)
  const [betAmount, setBetAmount] = useState<bigint>(0n)
  // FC-14: a never-executed bet refunds the protocol fee too. refundTotal = stake + protocolFee.
  const [protocolFee, setProtocolFee] = useState<bigint>(0n)
  const [attestation, setAttestation] = useState<SignedAttestation | null>(null)
  const [loading, setLoading] = useState(true)

  const nullifierOfBet = (receipt.nullifier_of_bet ?? receipt.nullifier) as `0x${string}`

  useEffect(() => {
    if (!open) return
    setPhase('input')
    setError(null)
    setLoading(true)
    void import('@/lib/prover').then(({ initProver }) => initProver())
    void (async () => {
      try {
        const att = await fetchAttestation(nullifierOfBet, REPORT_FAILED)
        if (!att || att.reportType !== REPORT_FAILED) {
          setError('No failure attestation is available for this bet yet. The operator signs it once the market order misses or the limit order expires. These proceeds release after PolyShield’s signing operator confirms the result — in beta this is a centralized service; if it’s delayed your funds stay safe in the vault, and an admin escape hatch can release them after a timelock.')
          setPhase('error')
          return
        }
        const rec = await fetchBetRecord(vaultAddress, nullifierOfBet)
        setAttestation(att)
        // Vault injects rec.bet_amount + protocolFee as the refund (FC-14); show both.
        setBetAmount(rec.betAmount)
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
      // Decoupled reclaim: spend the CURRENT note in this bet's deposit lineage and bind the bet
      // via bet_nonce = receipt.nonce (the circuit derives nullifier_of_bet = Poseidon2(secret,
      // bet_nonce)). This no longer requires the immediate post-bet note, so a later action that
      // consumed it doesn't orphan the reclaim.
      const freeNote = getFreeNoteForDeposit(address, receipt.depositIndex)
      if (!freeNote) {
        throw new Error(NO_FREE_NOTE_MSG)
      }
      if (betAmount <= 0n) {
        throw new Error('Nothing to reclaim for this bet.')
      }

      setPhase('proving')
      // FC-14: refund the stake AND the full protocol fee (the Vault injects exactly this sum).
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

      const { txHash } = await relayBetCancel(proof, {
        merkle_root: merkle.root,
        nullifier: freeNote.nullifier,
        new_commitment: newCommitment,
        nullifier_of_bet: nullifierOfBet,
      }, attestation ?? undefined)
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

      setPhase('done')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      // H3: a missing change-note is recoverable via Restore — route to the dedicated screen
      // instead of the raw error + a Retry that re-fails identically.
      setPhase(isNoFreeNote(message) ? 'cant-land' : 'error')
    }
  }

  // WCAG 4.1.3 — announce proof generation + the reclaimed result (the proof step is otherwise silent).
  const announce =
    phase === 'proving'
      ? 'Generating refund proof and crediting your stake back…'
      : phase === 'done'
        ? `Stake reclaimed. $${formatUsdc(betAmount + protocolFee)} returned to your balance.`
        : phase === 'cant-land'
          ? 'This reclaim can’t land yet — the change-note for this deposit isn’t in your local cache. Your funds are safe in the vault. Restore from chain to recover it.'
          : phase === 'error'
            ? error ?? 'Reclaim failed.'
            : ''

  return (
    <Modal open={open} title="Reclaim stake (order did not fill)" onClose={() => { if (phase !== 'proving') onClose() }}>
      <LiveRegion message={announce} assertive={phase === 'error'} />
      {phase === 'input' && (
        <div className="col gap-4">
          <p className="body" style={{ margin: 0 }}>
            This order never filled — a market order that missed, or a limit order that expired
            on the book. Reclaim your full stake back to your private balance.
          </p>
          <p className="small" style={{ margin: 0, color: 'var(--text-3)' }}>
            These proceeds release after PolyShield’s signing operator confirms the result. In beta
            this is a centralized service — if it’s delayed your funds stay safe in the vault, and an
            admin escape hatch can release them after a timelock.
          </p>
          <div className="panel" style={{ padding: 16 }}>
            <KV l="Market" v={receipt.marketId ?? receipt.id} />
            <KV l="Side" v={receipt.side ?? '—'} />
            <KV l="Stake" v={loading ? '…' : `$${formatUsdc(betAmount)} USDC`} />
            {protocolFee > 0n && <KV l="Protocol fee refund" v={loading ? '…' : `$${formatUsdc(protocolFee)} USDC`} />}
            <KV l="Total to reclaim" v={loading ? '…' : `$${formatUsdc(betAmount + protocolFee)} USDC`} />
          </div>
          <div className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={loading || betAmount <= 0n} onClick={() => void run()}>
              Reclaim ${formatUsdc(betAmount + protocolFee)}
            </button>
          </div>
        </div>
      )}

      {phase === 'proving' && (
        <div className="col gap-4">
          <div className="micro">GENERATING REFUND PROOF</div>
          <h3 className="h4" style={{ margin: 0 }}>Crediting your stake back to your note…</h3>
          <p className="small" style={{ margin: 0 }}>Do not close this window.</p>
        </div>
      )}

      {phase === 'done' && (
        <div className="col gap-4">
          <div className="micro" style={{ color: 'var(--green)' }}>STAKE RECLAIMED</div>
          <h3 className="h4" style={{ margin: 0 }}>+${formatUsdc(betAmount + protocolFee)} returned to your balance.</h3>
          <p className="small" style={{ margin: 0 }}>Auto close in 5 seconds.</p>
        </div>
      )}

      {phase === 'cant-land' && (
        <CreditCannotLand
          reason="no-free-note"
          onRestore={onRestore}
          restoring={restoring}
          onClose={onClose}
        />
      )}

      {phase === 'error' && (
        <div className="col gap-4">
          <div className="micro" style={{ color: 'var(--red)' }}>RECLAIM FAILED</div>
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
