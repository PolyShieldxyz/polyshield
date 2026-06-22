'use client'

/**
 * "Your Position" panel for the market detail page — shows the user's open position(s)/order(s) IN
 * THIS market, with live mark-to-market P&L, so a holder sees their stake exactly where they decide
 * to add to or close it. Cross-surface consistency: uses the SAME classify (lib/betClassify) and
 * pricing (lib/positionPricing) helpers as the Portfolio, so the numbers match to the cent.
 *
 * PRIVACY: positions are read ONLY from the local encrypted note cache (getOpenBetReceipts). The
 * market price is already fetched for every visitor regardless of holdings, so rendering this leaks
 * nothing — there is no holder-conditional network request and no analytics event here.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { getOpenBetReceipts, type Note } from '@/lib/notes'
import { fetchBetStatus, fetchAttestation } from '@/lib/api'
import { classifyReceipt } from '@/lib/betClassify'
import { positionValue, fmtCents, fmtSignedUsd, fmtSignedPct, pnlVisual } from '@/lib/positionPricing'

const REPORT_PARTIAL = 3

interface RowState { status: number; outcome: number; filled: bigint; spent: bigint }

interface Props {
  address: `0x${string}`
  vaultAddress: string
  conditionId: string // the market's REAL conditionId (raw)
  yesLabel: string
  noLabel: string
  yesMid: number | null // live YES midpoint (0–1), or null if unavailable
  refreshKey: number // bump from the parent to re-read after a bet/close
  onCloseReceipt: (r: Note) => void
}

const fmtShares = (scaled: bigint): string =>
  (Number(scaled) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })

export function MarketPositionPanel({ address, vaultAddress, conditionId, yesLabel, noLabel, yesMid, refreshKey, onCloseReceipt }: Props) {
  const [receipts, setReceipts] = useState<Note[]>([])
  const [rowState, setRowState] = useState<Record<string, RowState>>({})
  const [tick, setTick] = useState(0)

  // Internal 12s poll so a fill/cancel that lands after open is reflected without leaving the page.
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 12_000)
    return () => window.clearInterval(id)
  }, [])

  // This market's open receipts, read from the LOCAL cache only.
  useEffect(() => {
    const cid = conditionId.toLowerCase()
    setReceipts(getOpenBetReceipts(address).filter((r) => (r.raw_condition_id ?? r.condition_id)?.toLowerCase() === cid))
  }, [address, conditionId, refreshKey, tick])

  // On-chain status + operator attestation per receipt (bounded: only this market's receipts).
  useEffect(() => {
    if (receipts.length === 0) { setRowState({}); return }
    let cancelled = false
    void (async () => {
      const entries = await Promise.all(
        receipts.map(async (r) => {
          const n = (r.nullifier_of_bet ?? r.nullifier) as `0x${string}`
          let status = -1
          try { status = await fetchBetStatus(vaultAddress, n) } catch { /* leave -1 */ }
          const att = await fetchAttestation(n)
          const outcome = att ? att.reportType : 0
          const filled = att && att.reportType === REPORT_PARTIAL ? BigInt(att.amountA) : 0n
          const spent = att && att.reportType === REPORT_PARTIAL ? BigInt(att.amountB) : 0n
          return [r.id, { status, outcome, filled, spent }] as const
        }),
      )
      if (!cancelled) setRowState(Object.fromEntries(entries))
    })()
    return () => { cancelled = true }
  }, [receipts, vaultAddress, tick])

  if (receipts.length === 0) {
    return (
      <div className="panel mt-3" style={{ padding: 20 }}>
        <div className="micro">YOUR POSITION</div>
        <div className="small mt-2" style={{ color: 'var(--text-3)' }}>No open position in this market.</div>
        <div className="row gap-2 mt-3">
          <Link href="/app/deposit" className="btn btn-sm" style={{ flex: 1, justifyContent: 'center', textDecoration: 'none', fontSize: 12 }}>Deposit USDC</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="panel mt-3" style={{ padding: 20 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="micro">YOUR POSITION{receipts.length > 1 ? `S · ${receipts.length}` : ''}</div>
        <Link href="/app/portfolio" className="small" style={{ fontSize: 11, color: 'var(--cyan)', textDecoration: 'none' }}>Portfolio →</Link>
      </div>
      <div className="col gap-2 mt-3">
        {receipts.map((r) => {
          const st = rowState[r.id] ?? { status: -1, outcome: 0, filled: 0n, spent: 0n }
          const fill = st.filled > 0n ? { filled: st.filled, spent: st.spent } : undefined
          const cls = classifyReceipt({ status: st.status, outcome: st.outcome, betAmount: r.bet_amount ?? 0n, fill })
          const heldShares = fill && fill.filled > 0n ? fill.filled : (r.expectedShares ?? 0n)
          const stakeMicro = fill && fill.spent > 0n ? fill.spent : (r.bet_amount ?? r.balance ?? 0n)
          const side: 'YES' | 'NO' = r.side === 'NO' ? 'NO' : 'YES'
          const pricing = positionValue({ stakeMicro, shares: heldShares, side, yesMid })
          const sideLabel = r.sideLabel ?? (side === 'YES' ? yesLabel : noLabel)

          const [pill, pillCls] = cls.isFailed ? ['UNFILLED', 'pill-red']
            : cls.isPartial ? ['PARTIAL', 'pill-amber']
            : cls.isFilled ? ['FILLED', 'pill-green']
            : cls.isResting ? ['RESTING', 'pill-cyan']
            : ['PENDING', 'pill-soft']
          const v = pnlVisual(pricing.pnl)
          const closeable = cls.isFilled && !!r.position_id

          return (
            <div key={r.id} style={{ border: '1px solid var(--line)', borderRadius: 6, padding: 12 }}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 13, fontWeight: 500 }}>
                  {sideLabel} · <span className="num">{fmtShares(heldShares)}</span> shares
                </span>
                <span className={`pill ${pillCls}`} style={{ fontSize: 9 }}>{pill}</span>
              </div>

              {(cls.isFilled || cls.isPartial) ? (
                <>
                  <div className="row mt-2" style={{ justifyContent: 'space-between', fontSize: 11, color: 'var(--text-3)' }}>
                    <span>Entry {fmtCents(pricing.entryPrice)} · Mark {fmtCents(pricing.markPrice)}</span>
                  </div>
                  <div className="row mt-1" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span className="num" style={{ fontSize: 16 }}>{pricing.value == null ? '—' : `$${pricing.value.toFixed(2)}`}</span>
                    <span style={{ fontSize: 12, color: v.color }}>
                      {pricing.pnl == null ? '' : `${v.glyph} ${fmtSignedUsd(pricing.pnl)} ${fmtSignedPct(pricing.pnlPct) && `(${fmtSignedPct(pricing.pnlPct)})`}`}
                    </span>
                  </div>
                </>
              ) : cls.isResting ? (
                <div className="row mt-2" style={{ justifyContent: 'space-between', fontSize: 11, color: 'var(--text-3)' }}>
                  <span>Limit {fmtCents(pricing.entryPrice)} · Mark {fmtCents(pricing.markPrice)}</span>
                </div>
              ) : (
                <div className="small mt-2" style={{ fontSize: 11, color: 'var(--text-3)' }}>
                  {cls.isFailed ? 'Order didn’t fill — reclaim your stake in Portfolio.' : 'Order is being submitted…'}
                </div>
              )}

              {closeable && (
                <div className="row mt-3" style={{ justifyContent: 'flex-end' }}>
                  <button className="btn btn-sm" style={{ fontSize: 11 }} onClick={() => onCloseReceipt(r)}>Close</button>
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="small mt-3" style={{ fontSize: 10, color: 'var(--text-3)' }}>
        Mark-to-market vs your stake — excludes fees; realized only when you close or it settles.
      </div>
    </div>
  )
}
