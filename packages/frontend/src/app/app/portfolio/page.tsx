'use client'

import Link from 'next/link'
import { Suspense, useEffect, useMemo, useState } from 'react'
import { useAccount, useSignMessage } from 'wagmi'
import { useRouter, useSearchParams } from 'next/navigation'
import { SettlementModal } from '@/components/app/SettlementModal'
import { ClosePositionModal } from '@/components/app/ClosePositionModal'
import { PartialFillCreditModal } from '@/components/app/PartialFillCreditModal'
import { BetCancelRefundModal } from '@/components/app/BetCancelRefundModal'
import { Icon, ICONS } from '@/components/ui/Icon'
import { log } from '@/lib/logger'
import { addNote, getNotes, recoverNotes, recoverNotesViaBackend, formatUsdc, type Note } from '@/lib/notes'
import { BET_STATUS, fetchAttestation, fetchBetStatus, cancelPendingBet } from '@/lib/api'

// FC-9 attestation reportType (off-chain operator fill report): 1=FILLED, 2=FAILED, 3=PARTIAL.
const REPORT_FILLED = 1
const REPORT_FAILED = 2
const REPORT_PARTIAL = 3
import { portfolioSummaryRows, usePortfolioState } from '@/lib/accountState'

const VAULT_ADDRESS = (process.env.NEXT_PUBLIC_VAULT_ADDRESS ??
  '0x0000000000000000000000000000000000000000') as `0x${string}`

// Share counts are stored 1e6-scaled (like the on-chain order size); divide for display.
function fmtShares(scaled?: bigint): string {
  if (scaled === undefined || scaled === null) return '—'
  const n = Number(scaled) / 1e6
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// Next 15 requires any component calling useSearchParams() to be wrapped in a
// Suspense boundary, or `next build` fails. Content lives in PortfolioContent.
export default function PortfolioPage() {
  return (
    <Suspense fallback={null}>
      <PortfolioContent />
    </Suspense>
  )
}

function PortfolioContent() {
  const { address } = useAccount()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [modalOpen, setModalOpen] = useState(false)
  const [closeLostOpen, setCloseLostOpen] = useState(false)
  const [closeReceipt, setCloseReceipt] = useState<Note | null>(null)
  const [partialReceipt, setPartialReceipt] = useState<Note | null>(null)
  const [refundReceipt, setRefundReceipt] = useState<Note | null>(null)
  // receipt.id → on-chain BetStatus.
  const [betStatuses, setBetStatuses] = useState<Record<string, number>>({})
  // FC-9: receipt.id → the operator's off-chain bet-OUTCOME attestation reportType
  // (1=FILLED, 2=FAILED, 3=PARTIAL, or 0=none yet). A resting limit order is ACTIVE on-chain
  // either way, so this off-chain outcome — not the on-chain status — tells filled vs
  // resting vs expired apart, and drives the per-row label and action.
  const [betOutcomes, setBetOutcomes] = useState<Record<string, number>>({})
  // L3: receipt.id → the ACTUAL fill from a PARTIAL attestation (filled_shares, spent_amount,
  // both 1e6-scaled). Drives the per-row "Fill %" and the held-shares display so a downsized
  // market order shows what truly executed rather than the committed (now upper-bound) estimate.
  const [betFills, setBetFills] = useState<Record<string, { filled: bigint; spent: bigint }>>({})
  const { state, loading, refresh } = usePortfolioState(address)
  const { signMessageAsync } = useSignMessage()
  const [recovering, setRecovering] = useState(false)
  const [recoverMsg, setRecoverMsg] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState<string | null>(null)

  // Cancel/recover a stuck pending bet (order never reached Polymarket, or a resting order to
  // abandon). The operator attests FAILED if there's no live order (→ reclaimable here), or
  // cancels the resting order on the CLOB and the fill tracker finalizes it (FAILED/PARTIAL).
  const handleCancelBet = async (receipt: Note) => {
    const n = (receipt.nullifier_of_bet ?? receipt.nullifier) as string
    if (!n || cancelling) return
    setCancelling(receipt.id)
    try {
      const r = await cancelPendingBet(n)
      setRecoverMsg(
        r.outcome === 'failed' || r.outcome === 'already-finalized'
          ? 'Bet cancelled — you can now reclaim your stake below.'
          : 'Cancellation requested — the resting order is being cancelled; the reclaim/refund action will appear shortly.',
      )
      await refresh()
    } catch (e) {
      setRecoverMsg(`Cancel failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setCancelling(null)
    }
  }

  // Rebuild the local note cache from on-chain events (P3+ wallet-derived recovery). Needed
  // after clearing the browser cache or switching devices — the secret is never persisted,
  // so notes are re-derived from the wallet signature per deposit index and matched against
  // chain events. Prompts the wallet to sign once per deposit index scanned.
  const handleRecover = async () => {
    if (!address || recovering) return
    setRecovering(true)
    setRecoverMsg(null)
    try {
      const rpcUrl = process.env.NEXT_PUBLIC_CHAIN_RPC || process.env.NEXT_PUBLIC_POLYGON_RPC || undefined
      // Prefer the backend recovery data (events served from the proof-relay's index — fast, no
      // client RPC scan). Fall back to the direct on-chain scan if the backend endpoint is
      // unavailable (e.g. index not yet ready). The secret-based matching is identical either way.
      let recovered: Note[]
      try {
        recovered = await recoverNotesViaBackend(address, signMessageAsync, VAULT_ADDRESS, rpcUrl)
      } catch (backendErr) {
        console.warn('[recover] backend recovery-data unavailable, falling back to chain scan:', backendErr)
        recovered = await recoverNotes(address, signMessageAsync, VAULT_ADDRESS, rpcUrl)
      }
      const existing = new Set(getNotes().map((n) => n.id))
      let added = 0
      for (const n of recovered) {
        if (!existing.has(n.id)) { addNote(n); added++ }
      }
      setRecoverMsg(
        recovered.length === 0
          ? 'No notes found on-chain for this wallet.'
          : `Restored ${recovered.length} note(s) from chain (${added} new).`,
      )
      await refresh()
    } catch (e) {
      setRecoverMsg(`Restore failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRecovering(false)
    }
  }

  useEffect(() => {
    log('page_view', { route: '/app/portfolio' })
  }, [])

  useEffect(() => {
    if (searchParams.get('modal') === 'settle') {
      setModalOpen(true)
    }
  }, [searchParams])

  // FC-4: poll each open receipt's on-chain BetStatus so we can surface RESTING
  // (limit order live) and PARTIAL_FILLED (refund available) states/actions.
  const openReceiptKey = useMemo(
    () => (state?.openReceipts ?? []).map((r) => r.nullifier_of_bet ?? r.nullifier).join(','),
    [state],
  )
  useEffect(() => {
    const receipts = state?.openReceipts ?? []
    if (receipts.length === 0) { setBetStatuses({}); setBetOutcomes({}); return }
    let cancelled = false
    void (async () => {
      const entries = await Promise.all(
        receipts.map(async (r) => {
          const n = (r.nullifier_of_bet ?? r.nullifier) as `0x${string}`
          let status = -1
          let outcome = 0
          let filled = 0n
          let spent = 0n
          try { status = await fetchBetStatus(VAULT_ADDRESS, n) } catch { /* leave -1 */ }
          // FC-9: read the operator's bet-OUTCOME attestation. While the bet is still
          // open on-chain (ACTIVE/RESTING — not yet credited), this distinguishes a filled
          // position (FILLED → closeable) from an expired/missed order (FAILED → reclaim)
          // from a partial fill (PARTIAL → claim) from a still-resting order (none → pending).
          if (status === BET_STATUS.ACTIVE || status === BET_STATUS.RESTING) {
            const att = await fetchAttestation(n)
            outcome = att ? att.reportType : 0
            // L3: a PARTIAL attestation carries the ACTUAL fill (amountA=filled_shares,
            // amountB=spent_amount) — surface it for the Fill % and held-shares display.
            if (att && att.reportType === REPORT_PARTIAL) {
              filled = BigInt(att.amountA)
              spent = BigInt(att.amountB)
            }
          }
          return { id: r.id, status, outcome, filled, spent }
        }),
      )
      if (!cancelled) {
        setBetStatuses(Object.fromEntries(entries.map((e) => [e.id, e.status])))
        setBetOutcomes(Object.fromEntries(entries.map((e) => [e.id, e.outcome])))
        setBetFills(Object.fromEntries(entries.map((e) => [e.id, { filled: e.filled, spent: e.spent }])))
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openReceiptKey])

  const summaryRows = useMemo(() => (state ? portfolioSummaryRows(state) : []), [state])
  const readyByReceiptId = useMemo(() => {
    const map = new Set<string>()
    state?.readyToSettle.forEach((row) => map.add(row.receipt.id))
    return map
  }, [state])
  const lostBetIds = useMemo(() => {
    const map = new Set<string>()
    state?.lostBets.forEach((r) => map.add(r.id))
    return map
  }, [state])
  // Lost bets converted to ReadyToSettleBet format for the zero-credit close flow
  const lostBetsAsSettlement = useMemo(
    () => (state?.lostBets ?? []).map((r) => ({ receipt: r, payoutPerShare: 0n, claimAmount: 0n })),
    [state],
  )

  // Classify each open bet from the operator's outcome attestation. A FILLED/PARTIAL bet (or
  // one ready to settle) actually HOLDS SHARES → it's a POSITION. A still-pending or
  // expired/unfilled order holds no shares → it's an ORDER. The two are shown separately so a
  // resting limit order is never mistaken for (or acted on like) a filled position.
  const classify = (receipt: Note) => {
    const ready = readyByReceiptId.has(receipt.id)
    const outcome = betOutcomes[receipt.id] ?? 0
    // On-chain FILLED is authoritative: a partial-fill credit normalizes the record to FILLED, so
    // such a bet is a held position even before its market resolves (and its PARTIAL attestation
    // is no longer the live state). Without this it fell through to "PENDING" in OPEN ORDERS.
    const onchainFilled = (betStatuses[receipt.id] ?? -1) === BET_STATUS.FILLED
    const isPartial = outcome === REPORT_PARTIAL && !onchainFilled
    const isFailed = outcome === REPORT_FAILED
    const isFilled = outcome === REPORT_FILLED || onchainFilled
    return { ready, isPartial, isFailed, isFilled, isPosition: ready || isFilled || isPartial }
  }
  const visibleReceipts = (state?.openReceipts ?? []).filter((r) => !lostBetIds.has(r.id))
  const openPositions = visibleReceipts.filter((r) => classify(r).isPosition)
  const openOrders = visibleReceipts.filter((r) => !classify(r).isPosition)

  const renderReceiptRow = (receipt: Note) => {
    const { ready, isPartial, isFailed, isFilled } = classify(receipt)
    const label = ready ? 'READY TO SETTLE'
      : isPartial ? 'PARTIAL FILL'
      : isFailed ? 'EXPIRED / NOT FILLED'
      : isFilled ? 'FILLED'
      : 'PENDING'
    const pillClass = ready ? 'pill-green' : isPartial ? 'pill-amber' : isFailed ? 'pill-red' : 'pill-soft'
    // L3: show the ACTUAL fill. A partial fill holds `filled` shares (operator PARTIAL attestation);
    // a full fill holds the committed expected_shares. Fill % is vs the committed order size, so the
    // user sees how much of their order executed.
    const expected = receipt.expectedShares ?? 0n
    const fill = betFills[receipt.id]
    const heldShares = isPartial && fill && fill.filled > 0n ? fill.filled : expected
    const fillLabel = isFilled
      ? '100%'
      : isFailed
        ? '0%'
        : isPartial && fill && expected > 0n
          ? `${(Number((fill.filled * 1000n) / expected) / 10).toFixed(1)}%`
          : '—'
    return (
      <tr key={receipt.id}>
        <td>{receipt.marketId ?? receipt.id}</td>
        <td>{receipt.side ?? '—'}</td>
        <td className="num" style={{ textAlign: 'right' }}>${formatUsdc(receipt.bet_amount ?? receipt.balance)}</td>
        <td className="num" style={{ textAlign: 'right' }}>{fmtShares(heldShares)}</td>
        <td className="num" style={{ textAlign: 'right' }}>{fillLabel}</td>
        <td>
          <span className={`pill ${pillClass}`} style={{ fontSize: 10 }}>{label}</span>
        </td>
        <td style={{ textAlign: 'right' }}>
          {ready ? (
            <button className="btn btn-sm btn-primary" onClick={() => setModalOpen(true)}>Settle</button>
          ) : isPartial ? (
            <button className="btn btn-sm btn-primary" onClick={() => setPartialReceipt(receipt)}>Claim refund</button>
          ) : isFailed ? (
            <button className="btn btn-sm btn-primary" onClick={() => setRefundReceipt(receipt)}>Reclaim stake</button>
          ) : isFilled && receipt.position_id ? (
            // Close is only meaningful once the bet actually filled (there are shares to sell).
            <button className="btn btn-sm" onClick={() => setCloseReceipt(receipt)}>Close</button>
          ) : (
            <div className="row gap-2" style={{ justifyContent: 'flex-end', alignItems: 'center' }}>
              <span className="small" style={{ fontSize: 10, color: 'var(--text-3)' }}>
                {isFilled ? '—' : 'Waiting for fill…'}
              </span>
              {!isFilled && (
                <button
                  className="btn btn-sm"
                  disabled={cancelling === receipt.id}
                  title="Cancel this bet (e.g. its order never reached Polymarket) and reclaim your stake"
                  onClick={() => void handleCancelBet(receipt)}
                >
                  {cancelling === receipt.id ? 'Cancelling…' : 'Cancel'}
                </button>
              )}
            </div>
          )}
        </td>
      </tr>
    )
  }

  const closeModal = () => {
    setModalOpen(false)
    const next = new URLSearchParams(searchParams.toString())
    next.delete('modal')
    const query = next.toString()
    router.replace(query ? `/app/portfolio?${query}` : '/app/portfolio')
  }

  if (!address) return null

  return (
    <div>
      <div className="row hairline-b" style={{ padding: '14px 24px', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div className="row gap-4">
          <div className="micro">PORTFOLIO</div>
          <span className="pill pill-soft" style={{ fontSize: 10 }}>
            {state?.openReceipts.length ?? 0} open bets
          </span>
        </div>
        <div className="row gap-2">
          <button
            onClick={() => void handleRecover()}
            disabled={!address || recovering}
            className="btn btn-sm"
            title="Re-derive your notes from on-chain events (after a cache clear or new device). Prompts a wallet signature per deposit index."
          >
            <Icon d={ICONS.search} size={12} /> {recovering ? 'Restoring…' : 'Restore from chain'}
          </button>
          <Link href="/app/deposit" className="btn btn-sm" style={{ textDecoration: 'none' }}>
            <Icon d={ICONS.arrowDown} size={12} /> Deposit
          </Link>
          <Link href="/app/withdraw" className="btn btn-sm btn-primary" style={{ textDecoration: 'none' }}>
            <Icon d={ICONS.withdraw} size={12} /> Withdraw
          </Link>
        </div>
      </div>
      {recoverMsg && (
        <div className="row" style={{ padding: '8px 24px', fontSize: 12, color: 'var(--text-2)' }}>{recoverMsg}</div>
      )}

      <div style={{ padding: 24 }}>
        {loading && (
          <div className="panel" style={{ padding: 16, marginBottom: 16, color: 'var(--text-2)' }}>
            Loading portfolio state...
          </div>
        )}

        {state && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
              {summaryRows.map(([label, value, note]) => (
                <div key={label} className="panel" style={{ padding: 16 }}>
                  <div className="micro">{label}</div>
                  <div className="num mt-2" style={{ fontSize: 24 }}>{value}</div>
                  <div className="small mt-1" style={{ fontSize: 11 }}>{note}</div>
                </div>
              ))}
            </div>

            {/* Positions = bets that actually filled (you hold shares): settle / close / claim. */}
            <div className="panel mt-4" style={{ padding: 0, overflow: 'hidden' }}>
              <div className="row hairline-b" style={{ padding: '12px 16px', justifyContent: 'space-between' }}>
                <div className="micro">OPEN POSITIONS</div>
                <span className="small" style={{ fontSize: 11, color: 'var(--text-3)' }}>Filled — you hold shares</span>
              </div>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Market</th>
                    <th>Side</th>
                    <th style={{ textAlign: 'right' }}>Amount</th>
                    <th style={{ textAlign: 'right' }}>Shares</th>
                    <th style={{ textAlign: 'right' }}>Fill</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {openPositions.length === 0 && (
                    <tr>
                      <td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24, fontSize: 12 }}>
                        No open positions yet.
                      </td>
                    </tr>
                  )}
                  {openPositions.map(renderReceiptRow)}
                </tbody>
              </table>
            </div>

            {/* Orders = bets not (yet) filled — resting limit orders and expired/unfilled orders. */}
            <div className="panel mt-4" style={{ padding: 0, overflow: 'hidden' }}>
              <div className="row hairline-b" style={{ padding: '12px 16px', justifyContent: 'space-between' }}>
                <div className="micro">OPEN ORDERS</div>
                <span className="small" style={{ fontSize: 11, color: 'var(--text-3)' }}>Not filled — no shares held yet</span>
              </div>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Market</th>
                    <th>Side</th>
                    <th style={{ textAlign: 'right' }}>Amount</th>
                    <th style={{ textAlign: 'right' }}>Order shares</th>
                    <th style={{ textAlign: 'right' }}>Fill</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {openOrders.length === 0 && (
                    <tr>
                      <td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24, fontSize: 12 }}>
                        No open orders.
                      </td>
                    </tr>
                  )}
                  {openOrders.map(renderReceiptRow)}
                </tbody>
              </table>
            </div>

            <div className="panel mt-4" style={{ padding: 18 }}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <div>
                  <div className="micro">READY TO SETTLE</div>
                  <h3 className="h4 mt-2" style={{ margin: 0 }}>
                    {state.readyToSettle.length === 0
                      ? 'No resolved bets available yet.'
                      : `${state.readyToSettle.length} bet${state.readyToSettle.length === 1 ? '' : 's'} can be settled now.`}
                  </h3>
                </div>
                <button
                  className="btn btn-primary"
                  disabled={state.readyToSettle.length === 0}
                  style={{ opacity: state.readyToSettle.length === 0 ? 0.5 : 1 }}
                  onClick={() => setModalOpen(true)}
                >
                  Settle
                </button>
              </div>
              {state.readyToSettle.length > 0 && (
                <div className="col gap-2 mt-4">
                  {state.readyToSettle.map((row) => (
                    <div key={row.receipt.id} className="row" style={{ justifyContent: 'space-between', gap: 12, padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 6 }}>
                      <div>
                        <div style={{ fontSize: 13 }}>{row.receipt.marketId ?? row.receipt.id}</div>
                        <div className="small" style={{ fontSize: 11 }}>
                          Amount ${formatUsdc(row.receipt.bet_amount ?? row.receipt.balance)} · payout/share {row.payoutPerShare.toString()}
                        </div>
                      </div>
                      <div className="num" style={{ color: 'var(--green)' }}>+${formatUsdc(row.claimAmount)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="panel mt-4" style={{ padding: 0, overflow: 'hidden' }}>
              <div className="row hairline-b" style={{ padding: '12px 16px', justifyContent: 'space-between' }}>
                <div className="micro">CLOSED BETS</div>
                {state.lostBets.length > 0 && (
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={() => setCloseLostOpen(true)}
                    title="Generate ZK proof to formally close lost positions on-chain"
                  >
                    Close {state.lostBets.length} lost position{state.lostBets.length === 1 ? '' : 's'}
                  </button>
                )}
              </div>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Market</th>
                    <th>Side</th>
                    <th style={{ textAlign: 'right' }}>Amount bet</th>
                    <th style={{ textAlign: 'right' }}>Settlement</th>
                    <th style={{ textAlign: 'right' }}>Gain / Loss</th>
                    <th>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {state.closedBetHistory.length === 0 && state.lostBets.length === 0 && (
                    <tr>
                      <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24, fontSize: 12 }}>
                        No closed bets yet.
                      </td>
                    </tr>
                  )}
                  {state.lostBets.map((receipt) => (
                    <tr key={receipt.id}>
                      <td>{receipt.marketId ?? receipt.id}</td>
                      <td>{receipt.side ?? '—'}</td>
                      <td className="num" style={{ textAlign: 'right' }}>${formatUsdc(receipt.bet_amount ?? receipt.balance)}</td>
                      <td className="num" style={{ textAlign: 'right', color: 'var(--text-3)' }}>—</td>
                      <td className="num" style={{ textAlign: 'right', color: 'var(--red)' }}>
                        −${formatUsdc(receipt.bet_amount ?? receipt.balance)}
                      </td>
                      <td className="small">{formatDate(receipt.createdAt)}</td>
                    </tr>
                  ))}
                  {state.closedBetHistory.map((row) => (
                    <tr key={row.id}>
                      <td>{row.marketId ?? row.id}</td>
                      <td>{row.side ?? '—'}</td>
                      <td className="num" style={{ textAlign: 'right' }}>${formatUsdc(row.betAmount)}</td>
                      <td className="num" style={{ textAlign: 'right' }}>${formatUsdc(row.amount)}</td>
                      <td className="num" style={{ textAlign: 'right', color: row.pnl >= 0n ? 'var(--green)' : 'var(--red)' }}>
                        {row.pnl >= 0n ? '+' : '−'}${formatUsdc(row.pnl >= 0n ? row.pnl : -row.pnl)}
                      </td>
                      <td className="small">{formatDate(row.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, marginTop: 16 }}>
              <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
                <div className="row hairline-b" style={{ padding: '12px 16px' }}>
                  <div className="micro">DEPOSIT HISTORY</div>
                </div>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Amount</th>
                      <th>Date</th>
                      <th>Tx</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.depositHistory.length === 0 && (
                      <tr>
                        <td colSpan={3} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 20, fontSize: 12 }}>
                          No deposits yet.
                        </td>
                      </tr>
                    )}
                    {state.depositHistory.map((row) => (
                      <tr key={row.id}>
                        <td className="num">${formatUsdc(row.amount)}</td>
                        <td className="small">{formatDate(row.createdAt)}</td>
                        <td className="mono small">{row.txHash ? `${row.txHash.slice(0, 10)}…${row.txHash.slice(-8)}` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
                <div className="row hairline-b" style={{ padding: '12px 16px' }}>
                  <div className="micro">WITHDRAWAL HISTORY</div>
                </div>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Amount</th>
                      <th>Destination</th>
                      <th>Date</th>
                      <th>Tx</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.withdrawalHistory.length === 0 && (
                      <tr>
                        <td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 20, fontSize: 12 }}>
                          No withdrawals yet.
                        </td>
                      </tr>
                    )}
                    {state.withdrawalHistory.map((row) => (
                      <tr key={row.id}>
                        <td className="num">${formatUsdc(row.amount)}</td>
                        <td className="small">Your wallet</td>
                        <td className="small">{formatDate(row.createdAt)}</td>
                        <td className="mono small">{row.txHash ? `${row.txHash.slice(0, 10)}…${row.txHash.slice(-8)}` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>

      {state && modalOpen && (
        <SettlementModal
          open={modalOpen}
          address={address}
          readyBets={state.readyToSettle}
          onClose={closeModal}
          onComplete={refresh}
        />
      )}
      {state && closeLostOpen && (
        <SettlementModal
          open={closeLostOpen}
          address={address}
          readyBets={lostBetsAsSettlement}
          mode="close-losses"
          onClose={() => setCloseLostOpen(false)}
          onComplete={async () => { setCloseLostOpen(false); await refresh() }}
        />
      )}
      {address && closeReceipt && (
        <ClosePositionModal
          open={!!closeReceipt}
          address={address}
          receipt={closeReceipt}
          vaultAddress={VAULT_ADDRESS}
          onClose={() => setCloseReceipt(null)}
          onComplete={async () => { setCloseReceipt(null); await refresh() }}
        />
      )}
      {address && partialReceipt && (
        <PartialFillCreditModal
          open={!!partialReceipt}
          address={address}
          receipt={partialReceipt}
          vaultAddress={VAULT_ADDRESS}
          onClose={() => setPartialReceipt(null)}
          onComplete={async () => { setPartialReceipt(null); await refresh() }}
        />
      )}
      {address && refundReceipt && (
        <BetCancelRefundModal
          open={!!refundReceipt}
          address={address}
          receipt={refundReceipt}
          vaultAddress={VAULT_ADDRESS}
          onClose={() => setRefundReceipt(null)}
          onComplete={async () => { setRefundReceipt(null); await refresh() }}
        />
      )}
    </div>
  )
}
