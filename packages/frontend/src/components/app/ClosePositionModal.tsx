'use client'

import { useEffect, useState } from 'react'
import { useSignMessage } from 'wagmi'
import { Modal } from '@/components/app/Modal'
import { KV } from '@/components/app/KV'
import {
  addNote,
  computeCommitment,
  computeNullifier,
  formatUsdc,
  getFreeNoteForDeposit,
  markNoteSpent,
  markBetReceiptSpent,
  recordWalletActivity,
  type Note,
} from '@/lib/notes'
import { getNoteSecret } from '@/lib/secretSession'
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
import { type OrderKind, ORDER_KIND_LABEL } from '@/lib/orderType'

// FC-9: proceeds are conveyed by the operator's SOLD attestation (reportType 4), not an
// on-chain CLOSING status. We poll the attestation endpoint until the operator signs it.
const REPORT_SOLD = 4

// Polymarket prices live in (0,1) — i.e. (0¢, 100¢), and can be fractional below 1¢ or above 99¢.
// Allow up to 2 decimal places of a cent; clamp into the open interval only when we actually use it.
const clampPriceCents = (p: number): number => Math.min(99.99, Math.max(0.01, Number.isFinite(p) ? p : 0.01))

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
  // limit price in cents (0.01..99.99, up to 2 decimals) → 1e6-scaled probability; full position.
  const [priceCents, setPriceCents] = useState(50)
  // Market (FAK) close = sell now at ≥ the floor; Limit (GTC/GTD) close = rest at the price.
  const [orderKind, setOrderKind] = useState<OrderKind>('MARKET')
  const [expiryEnabled, setExpiryEnabled] = useState(false)
  const [expiryMinutes, setExpiryMinutes] = useState(60)
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
  // signs it once the SELL fills, fully or partially). Returns the signed attestation.
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
    throw new Error('The close has not filled yet — your position stays open. A limit close keeps resting on the book; reopen Close later to credit it once it fills, or try a more aggressive price.')
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

    // Full close in this UI. limit_price is 1e6-scaled (priceCents/100 * 1e6). A MARKET close needs
    // no user price — sell at the best available bid with a low protective floor; a LIMIT close uses
    // the user's price (cents, up to 2 decimals).
    const limitPrice =
      orderKind === 'MARKET'
        ? 1n // permissive floor; the signing layer prices the market SELL at the live best bid (which
             // IS the market price), so it crosses any book — including sub-1¢ markets.
        : BigInt(Math.round(clampPriceCents(priceCents) * 10_000))

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
        order_type: orderKind === 'LIMIT' ? (expiryEnabled ? 'GTD' : 'GTC') : 'FAK',
        expiration: orderKind === 'LIMIT' && expiryEnabled ? expiryMinutes * 60 : undefined,
      })
      // A Market (FAK) close fills now; a resting Limit (GTC/GTD) close can take a while.
      const soldAtt = await pollUntilSold(nullifierOfBet, orderKind === 'LIMIT' ? 180_000 : 60_000)
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

      const secret = await getNoteSecret(signMessageAsync, address, freeNote.depositIndex, freeNote.derivationVersion ?? 1)
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
      // Full close → retire the receipt (terminal). Partial close → keep it: the unsold remainder
      // still settles at resolution (the Vault nets out sold_shares in creditSettlement).
      const fullClose = BigInt(soldAtt.amountA) >= rec.expectedShares
      if (fullClose) markBetReceiptSpent(nullifierOfBet)
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
        derivationVersion: freeNote.derivationVersion ?? 1, // FC-13: inherit lineage version
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
            Sell your shares back before the market resolves. A <strong>Market</strong> close sells now
            at the best available price (down to your floor); a <strong>Limit</strong> close rests at
            your price until it fills or expires. Either may fill partially — the unfilled remainder
            stays open and settles at resolution. Proceeds are credited to your private balance.
          </p>
          <div className="panel" style={{ padding: 16 }}>
            <KV l="Market" v={receipt.marketId ?? receipt.id} />
            <KV l="Shares" v={(Number(totalShares) / 1e6).toFixed(2)} />
            <KV l="Stake" v={`$${formatUsdc(receipt.bet_amount ?? receipt.balance)}`} />
          </div>
          <div className="col gap-2">
            <span className="micro">ORDER TYPE</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              {(['MARKET', 'LIMIT'] as OrderKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setOrderKind(k)}
                  className={`btn btn-sm ${orderKind === k ? 'btn-cyan' : 'btn-ghost'}`}
                  style={{ justifyContent: 'center', fontSize: 11 }}
                >
                  {ORDER_KIND_LABEL[k]}
                </button>
              ))}
            </div>
          </div>
          {/* Market close sells at the best available bid → no price to enter. Only a LIMIT close
              takes a price (cents, up to 2 decimals; Polymarket allows below 1¢ and above 99¢). */}
          {orderKind === 'LIMIT' && (
            <label className="col gap-2">
              <span className="micro">LIMIT PRICE (¢ per share)</span>
              <input
                type="number" min={0.01} max={99.99} step={0.01} value={priceCents}
                onChange={(e) => setPriceCents(Number(e.target.value))}
                onBlur={(e) => setPriceCents(clampPriceCents(Number(e.target.value)))}
                className="input"
              />
            </label>
          )}
          {orderKind === 'LIMIT' && (
            <label className="col gap-2">
              <span className="row gap-2" style={{ alignItems: 'center' }}>
                <input type="checkbox" checked={expiryEnabled} onChange={(e) => setExpiryEnabled(e.target.checked)} />
                <span className="micro">SET EXPIRATION</span>
              </span>
              {expiryEnabled && (
                <input
                  type="number" min={1} value={expiryMinutes}
                  onChange={(e) => setExpiryMinutes(Math.max(1, Number(e.target.value) || 1))}
                  aria-label="Expiry in minutes"
                  className="input"
                />
              )}
            </label>
          )}
          <div className="panel" style={{ padding: 16 }}>
            {/* FC-14: a market SELL is a taker — Polymarket deducts its fee from the proceeds. For a
                LIMIT close we can estimate net proceeds at the chosen price; a MARKET close fills at
                the best bid (unknown until fill), so we don't show a dollar figure. Exact proceeds
                come from the operator's SOLD attestation. */}
            {orderKind === 'LIMIT' ? (
              <KV
                l="Est. proceeds (net of ~Polymarket fee)"
                v={`≈ $${formatUsdc(
                  (((totalShares * BigInt(Math.round(clampPriceCents(priceCents) * 10_000))) / 1_000_000n) *
                    (10_000n - BigInt(process.env.NEXT_PUBLIC_CLOB_TAKER_FEE_BPS ?? '0'))) /
                    10_000n,
                )} USDC`}
              />
            ) : (
              <KV l="Proceeds" v="Sold at the best available bid (net of Polymarket fee)" />
            )}
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
              ? 'Waiting for your close order to fill on Polymarket…'
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
