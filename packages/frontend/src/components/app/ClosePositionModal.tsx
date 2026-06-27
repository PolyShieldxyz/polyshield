'use client'

import { useEffect, useState } from 'react'
import { useSignMessage } from 'wagmi'
import * as ToggleGroup from '@radix-ui/react-toggle-group'
import { Modal } from '@/components/app/Modal'
import { KV } from '@/components/app/KV'
import { LiveRegion } from '@/components/app/LiveRegion'
import { CreditCannotLand } from '@/components/app/CreditCannotLand'
import { formatUsdc, type Note } from '@/lib/notes'
import { fetchAttestation, fetchBetRecord, requestClose } from '@/lib/api'
import { finalizeClose } from '@/lib/finalizeClose'
import { markCloseSubmitted, clearCloseMarker } from '@/lib/closeMarker'
import { type OrderKind, ORDER_KIND_LABEL } from '@/lib/orderType'

// FC-9: proceeds are conveyed by the operator's SOLD attestation (reportType 4), not an
// on-chain CLOSING status. We poll the attestation endpoint until the operator signs it.
const REPORT_SOLD = 4
// A market (FAK) close fills in seconds or is killed — wait this long inline for immediate feedback,
// then hand off. A LIMIT close never blocks; it goes straight to the background finalizer.
const MARKET_WAIT_MS = 30_000

// Polymarket prices live in (0,1) — i.e. (0¢, 100¢), and can be fractional below 1¢ or above 99¢.
// Allow up to 2 decimal places of a cent; clamp into the open interval only when we actually use it.
const clampPriceCents = (p: number): number => Math.min(99.99, Math.max(0.01, Number.isFinite(p) ? p : 0.01))

// 'resting' (new) = the SELL is live on the book / awaiting credit; the user is free to leave and the
// portfolio's background finalizer credits the proceeds when the operator's SOLD attestation lands.
// H3: 'cant-close' = a structural gap (missing position_id / no shares) that no Retry can fix —
// surfaced via the dedicated CreditCannotLand screen (support CTA, no Retry) instead of raw error.
type Phase = 'input' | 'selling' | 'proving' | 'resting' | 'done' | 'error' | 'cant-close'

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

  // Auto-dismiss the "resting" confirmation after a few seconds. The order is now in the portfolio's
  // hands (background finalizer), and the portfolio holds off finalizing the receipt that's open in
  // this modal — so closing it promptly hands off cleanly. The user can also dismiss immediately.
  useEffect(() => {
    if (phase !== 'resting') return
    const id = window.setTimeout(() => { void onComplete() }, 6_000)
    return () => window.clearTimeout(id)
  }, [phase, onComplete])

  const run = async () => {
    setError(null)
    const nullifierOfBet = (receipt.nullifier_of_bet ?? receipt.nullifier) as `0x${string}`
    const positionId = receipt.position_id
    // H3: these are STRUCTURAL — no Retry can produce a missing position_id or conjure shares.
    // Route to the dedicated "can't close automatically" screen (support CTA, no Retry).
    if (!positionId) {
      setPhase('cant-close'); setError('This position is missing its CTF position_id and cannot be closed.'); return
    }
    if (totalShares <= 0n) {
      setPhase('cant-close'); setError('Position has no shares to sell.'); return
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

      // Phase 1: ask the signing layer to submit the SELL.
      setPhase('selling')
      await requestClose({
        nullifier_of_bet: nullifierOfBet,
        position_id: positionId,
        sold_shares: soldShares.toString(),
        limit_price: limitPrice.toString(),
        order_type: orderKind === 'LIMIT' ? (expiryEnabled ? 'GTD' : 'GTC') : 'FAK',
        expiration: orderKind === 'LIMIT' && expiryEnabled ? expiryMinutes * 60 : undefined,
      })

      // Record the in-flight close so the portfolio can finalize it in the BACKGROUND even if this
      // window is closed — the proceeds credit when the operator's SOLD attestation lands. This is
      // what makes a resting limit close non-blocking (no "do not close this tab" trap).
      markCloseSubmitted(address, {
        nullifierOfBet,
        depositIndex: receipt.depositIndex,
        orderKind,
        priceCents: orderKind === 'LIMIT' ? clampPriceCents(priceCents) : 0,
        expiration: orderKind === 'LIMIT' && expiryEnabled ? expiryMinutes * 60 : 0,
        submittedAt: Date.now(),
      })

      if (orderKind === 'LIMIT') {
        // A limit close rests on the book — possibly for a long time. Do NOT block: hand off to the
        // background finalizer and free the user immediately.
        setPhase('resting')
        return
      }

      // Market (FAK): fills now or is killed (it never rests). Wait briefly for the SOLD attestation,
      // then credit inline for immediate feedback.
      const start = Date.now()
      while (Date.now() - start < MARKET_WAIT_MS) {
        const att = await fetchAttestation(nullifierOfBet, REPORT_SOLD)
        if (att && att.reportType === REPORT_SOLD) {
          setPhase('proving')
          const res = await finalizeClose(address, receipt, vaultAddress, signMessageAsync)
          if (res.done) {
            setProceeds(res.proceeds)
            clearCloseMarker(address, nullifierOfBet)
            setPhase('done')
          } else {
            // SOLD seen but couldn't credit yet (e.g. no free note this instant) — keep the marker;
            // the background finalizer will complete it.
            setPhase('resting')
          }
          return
        }
        await new Promise((r) => setTimeout(r, 2_000))
      }
      // No fill in the window → the FAK was killed (a market sell never rests). Nothing was sold.
      clearCloseMarker(address, nullifierOfBet)
      setPhase('error')
      setError('The market close didn’t fill — your position is still open. Try again, or use a Limit close to rest on the book.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase('error')
    }
  }

  // WCAG 4.1.3 — announce each milestone.
  const announce =
    phase === 'selling'
      ? 'Submitting your close order to Polymarket…'
      : phase === 'proving'
        ? 'Crediting your proceeds…'
        : phase === 'resting'
          ? 'Your sell order is working. We’ll credit your balance automatically when it fills — you can leave this page.'
          : phase === 'done'
            ? `Position closed. $${formatUsdc(proceeds)} credited to your balance.`
            : phase === 'cant-close'
              ? 'This position can’t be closed automatically. Your funds are safe in the vault and can still be settled at resolution.'
              : phase === 'error'
                ? error ?? 'Close failed.'
                : ''

  return (
    <Modal open={open} title="Close position (sell before settlement)" onClose={() => { if (phase !== 'selling' && phase !== 'proving') onClose() }}>
      <LiveRegion message={announce} assertive={phase === 'error'} />
      {phase === 'input' && (
        <div className="col gap-4">
          <p className="body" style={{ margin: 0 }}>
            Sell your shares back before the market resolves. A <strong>Market</strong> close sells now
            at the best available price (down to your floor); a <strong>Limit</strong> close rests at
            your price until it fills or expires — you don’t have to wait around, we credit you
            automatically when it fills. Either may fill partially; the unfilled remainder stays open
            and settles at resolution. Proceeds are credited to your private balance.
          </p>
          <p className="small" style={{ margin: 0, color: 'var(--text-3)' }}>
            These proceeds release after PolyShield’s signing operator confirms the sale. In beta
            this is a centralized service — if it’s delayed your funds stay safe in the vault, and an
            admin escape hatch can release them after a timelock.
          </p>
          <div className="panel" style={{ padding: 16 }}>
            <KV l="Market" v={receipt.marketId ?? receipt.id} />
            <KV l="Shares" v={(Number(totalShares) / 1e6).toFixed(2)} />
            <KV l="Stake" v={`$${formatUsdc(receipt.bet_amount ?? receipt.balance)}`} />
          </div>
          <div className="col gap-2">
            <span className="micro">ORDER TYPE</span>
            <ToggleGroup.Root type="single" value={orderKind} onValueChange={(v) => { if (v) setOrderKind(v as OrderKind) }} aria-label="Order type" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              {(['MARKET', 'LIMIT'] as OrderKind[]).map((k) => (
                <ToggleGroup.Item
                  key={k}
                  value={k}
                  className={`btn btn-sm ${orderKind === k ? 'btn-cyan' : 'btn-ghost'}`}
                  style={{ justifyContent: 'center', fontSize: 11 }}
                >
                  {ORDER_KIND_LABEL[k]}
                </ToggleGroup.Item>
              ))}
            </ToggleGroup.Root>
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
          <div className="micro">{phase === 'selling' ? 'SUBMITTING SELL' : 'CREDITING PROCEEDS'}</div>
          <h3 className="h4" style={{ margin: 0 }}>
            {phase === 'selling'
              ? 'Filling your market close on Polymarket…'
              : 'Crediting the sale proceeds to your note…'}
          </h3>
          <p className="small" style={{ margin: 0 }}>This usually takes a few seconds.</p>
        </div>
      )}

      {phase === 'resting' && (
        <div className="col gap-4">
          <div className="micro" style={{ color: 'var(--cyan)' }}>SELL ORDER WORKING</div>
          <h3 className="h4" style={{ margin: 0 }}>
            {orderKind === 'LIMIT'
              ? `Resting at ${clampPriceCents(priceCents).toFixed(2)}¢ on Polymarket.`
              : 'Sale captured — crediting shortly.'}
          </h3>
          <p className="body" style={{ margin: 0 }}>
            You can safely close this window and keep using the app — we’ll credit your balance
            automatically when it fills. Track it as <strong>“Sell resting”</strong> on your Portfolio,
            where you can also cancel it.
          </p>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" onClick={() => void onComplete()}>Done</button>
          </div>
        </div>
      )}

      {phase === 'done' && (
        <div className="col gap-4">
          <div className="micro" style={{ color: 'var(--green)' }}>POSITION CLOSED</div>
          <h3 className="h4" style={{ margin: 0 }}>+${formatUsdc(proceeds)} credited to your balance.</h3>
          <p className="small" style={{ margin: 0 }}>Auto close in 5 seconds.</p>
        </div>
      )}

      {phase === 'cant-close' && (
        <CreditCannotLand
          reason="structural"
          detail={error ?? undefined}
          onClose={onClose}
        />
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
