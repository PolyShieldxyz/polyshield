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
  getFreeNoteForDeposit,
  markNoteSpent,
  markBetReceiptSpent,
  recordWalletActivity,
  type Note,
} from '@/lib/notes'
import {
  fetchMerklePath,
  fetchAttestation,
  fetchBetRecord,
  relayClose,
  requestClose,
  waitForTransactionConfirmation,
  type SignedAttestation,
} from '@/lib/api'
import { generatePositionCloseProof } from '@/lib/prover'

// FC-9: proceeds are conveyed by the operator's SOLD attestation (reportType 4), not an
// on-chain CLOSING status. We poll the attestation endpoint until the operator signs it.
const REPORT_SOLD = 4

type Phase = 'input' | 'selling' | 'proving' | 'done' | 'error'

interface ClosePositionModalProps {
  open: boolean
  address: `0x${string}`
  receipt: Note // a BET_RECEIPT note (must carry position_id + nullifier_of_bet)
  vaultAddress: string
  onClose: () => void
  onComplete: () => Promise<void> | void
}

export function ClosePositionModal({
  open,
  address,
  receipt,
  vaultAddress,
  onClose,
  onComplete,
}: ClosePositionModalProps) {
  const { signMessageAsync } = useSignMessage()
  const [phase, setPhase] = useState<Phase>('input')
  // limit price in cents (1..99) → 1e6-scaled probability; shares default = full position.
  const [priceCents, setPriceCents] = useState(50)
  const [error, setError] = useState<string | null>(null)
  const [proceeds, setProceeds] = useState<bigint>(0n)

  const totalShares = receipt.expectedShares ?? 0n // 1e6-scaled

  useEffect(() => {
    if (!open) return
    setPhase('input')
    setError(null)
    setProceeds(0n)
    void import('@/lib/prover').then(({ initProver }) => initProver())
  }, [open, receipt])

  useEffect(() => {
    if (phase !== 'done') return
    const id = window.setTimeout(() => { void onComplete(); onClose() }, 5_000)
    return () => window.clearTimeout(id)
  }, [phase, onClose, onComplete])

  // Poll the operator's attestation endpoint until a SOLD attestation appears (the operator
  // signs it once the FOK SELL fills). Returns the signed attestation.
  async function pollUntilSold(nullifierOfBet: `0x${string}`, timeoutMs = 60_000): Promise<SignedAttestation> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      // Fetch the SOLD slot specifically (reportType 4). A filled position already has a
      // FILLED bet-outcome attestation; without this selector the store would return FILLED
      // and the close would never see SOLD (the cause of the "did not fill in time" timeout).
      const att = await fetchAttestation(nullifierOfBet, REPORT_SOLD)
      if (att && att.reportType === REPORT_SOLD) return att
      await new Promise((r) => setTimeout(r, 2_000))
    }
    throw new Error('Sell order did not fill in time (position stays open). Try a more aggressive limit price.')
  }

  const run = async () => {
    setError(null)
    const nullifierOfBet = (receipt.nullifier_of_bet ?? receipt.nullifier) as `0x${string}`
    const positionId = receipt.position_id
    if (!positionId) {
      setPhase('error'); setError('This position is missing its CTF position_id and cannot be closed.'); return
    }
    if (totalShares <= 0n) {
      setPhase('error'); setError('Position has no shares to sell.'); return
    }

    // Full close in this UI. limit_price is 1e6-scaled (priceCents/100 * 1e6).
    const limitPrice = BigInt(priceCents) * 10_000n // cents → 1e6 scale

    try {
      // Size the SELL from the authoritative on-chain expected_shares (full close), NOT the
      // possibly-stale localStorage receipt. The Vault requires the SOLD attestation's
      // sold_shares == expected_shares exactly, so the operator must sell that exact amount.
      const rec = await fetchBetRecord(vaultAddress, nullifierOfBet)
      const soldShares = rec.expectedShares

      // Phase 1: ask the signing layer to submit the FOK SELL, then wait for the operator's
      // SOLD attestation (FC-9: gasless — no on-chain CLOSING status anymore).
      setPhase('selling')
      await requestClose({
        nullifier_of_bet: nullifierOfBet,
        position_id: positionId,
        sold_shares: soldShares.toString(),
        limit_price: limitPrice.toString(),
      })
      const soldAtt = await pollUntilSold(nullifierOfBet)
      // Use the operator-attested proceeds; the Vault injects att.amountB as sell_proceeds.
      const computedProceeds = BigInt(soldAtt.amountB)
      setProceeds(computedProceeds)

      // Phase 2: credit the proceeds into the note via a position_close proof.
      // Must spend a note from the SAME deposit chain as the bet receipt: the close
      // circuit derives nullifier_of_bet = Poseidon2(secret, bet_nonce) from this
      // note's deposit index, so a note from a different deposit would produce a
      // non-matching nullifier_of_bet and the proof would not verify. No cross-deposit
      // fallback (that mismatch is exactly the bug being fixed).
      setPhase('proving')
      const freeNote = getFreeNoteForDeposit(address, receipt.depositIndex)
      if (!freeNote) {
        throw new Error('No spendable note for this position’s deposit. Recover your notes and try again.')
      }

      const secret = await deriveSecret(signMessageAsync, address, freeNote.depositIndex)
      const merkle = await fetchMerklePath(freeNote.commitment)
      const newNonce = freeNote.nonce + 1n
      const newBalance = freeNote.balance + computedProceeds
      const newCommitment = computeCommitment(secret, newBalance, newNonce, address)
      const newNullifier = computeNullifier(secret, newNonce)

      const { proof } = await generatePositionCloseProof({
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
        sell_proceeds: computedProceeds,
      })

      const { txHash } = await relayClose(proof, {
        merkle_root: merkle.root,
        nullifier: freeNote.nullifier,
        new_commitment: newCommitment,
        nullifier_of_bet: nullifierOfBet,
      }, soldAtt)
      await waitForTransactionConfirmation(txHash as `0x${string}`)

      markNoteSpent(freeNote.commitment)
      markBetReceiptSpent(nullifierOfBet)
      recordWalletActivity({
        id: `close-${txHash}-${receipt.id}`,
        wallet: address,
        kind: 'settlement',
        amount: computedProceeds,
        createdAt: Date.now(),
        txHash,
        marketId: receipt.marketId as `0x${string}` | undefined,
        receiptId: receipt.id,
        receiptNullifier: nullifierOfBet,
        payout: computedProceeds,
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
      }
      addNote(credited)
      setPhase('done')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase('error')
    }
  }

  return (
    <Modal open={open} title="Close position (sell before settlement)" onClose={() => { if (phase !== 'selling' && phase !== 'proving') onClose() }}>
      {phase === 'input' && (
        <div className="col gap-4">
          <p className="body" style={{ margin: 0 }}>
            Submit a fill-or-kill SELL of your shares at a limit price. If it fills, the proceeds
            are credited back to your private balance. If it does not fill, nothing changes and the
            position stays open.
          </p>
          <div className="panel" style={{ padding: 16 }}>
            <KV l="Market" v={receipt.marketId ?? receipt.id} />
            <KV l="Shares" v={(Number(totalShares) / 1e6).toFixed(2)} />
            <KV l="Stake" v={`$${formatUsdc(receipt.bet_amount ?? receipt.balance)}`} />
          </div>
          <label className="col gap-2">
            <span className="micro">LIMIT PRICE (¢ per share, 1–99)</span>
            <input
              type="number" min={1} max={99} value={priceCents}
              onChange={(e) => setPriceCents(Math.max(1, Math.min(99, Number(e.target.value) || 1)))}
              className="input"
            />
          </label>
          <div className="panel" style={{ padding: 16 }}>
            <KV l="Est. proceeds if filled" v={`$${formatUsdc((totalShares * BigInt(priceCents) * 10_000n) / 1_000_000n)} USDC`} />
          </div>
          <div className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={() => void run()}>Submit SELL</button>
          </div>
        </div>
      )}

      {(phase === 'selling' || phase === 'proving') && (
        <div className="col gap-4">
          <div className="micro">{phase === 'selling' ? 'SUBMITTING SELL' : 'GENERATING CLOSE PROOF'}</div>
          <h3 className="h4" style={{ margin: 0 }}>
            {phase === 'selling'
              ? 'Waiting for the fill-or-kill SELL to fill on Polymarket…'
              : 'Crediting the sale proceeds back to your note…'}
          </h3>
          <p className="small" style={{ margin: 0 }}>Do not close this window.</p>
        </div>
      )}

      {phase === 'done' && (
        <div className="col gap-4">
          <div className="micro" style={{ color: 'var(--green)' }}>POSITION CLOSED</div>
          <h3 className="h4" style={{ margin: 0 }}>+${formatUsdc(proceeds)} credited to your balance.</h3>
          <p className="small" style={{ margin: 0 }}>Auto close in 5 seconds.</p>
        </div>
      )}

      {phase === 'error' && (
        <div className="col gap-4">
          <div className="micro" style={{ color: 'var(--red)' }}>CLOSE FAILED</div>
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
