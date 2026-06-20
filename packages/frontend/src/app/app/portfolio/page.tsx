'use client'

import Link from 'next/link'
import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useAccount, useSignMessage } from 'wagmi'
import { useRouter, useSearchParams } from 'next/navigation'
import { SettlementModal } from '@/components/app/SettlementModal'
import { ClosePositionModal } from '@/components/app/ClosePositionModal'
import { PartialFillCreditModal } from '@/components/app/PartialFillCreditModal'
import { BetCancelRefundModal } from '@/components/app/BetCancelRefundModal'
import { LiveRegion } from '@/components/app/LiveRegion'
import { Icon, ICONS } from '@/components/ui/Icon'
import { log } from '@/lib/logger'
import { addNote, getNotes, recoverNotes, recoverNotesViaBackend, formatUsdc, type Note } from '@/lib/notes'
import { getMasterSeed, hasMasterSeed } from '@/lib/secretSession'
import { finalizePartialFill } from '@/lib/finalizePartial'
import { BET_STATUS, fetchAttestation, fetchBetStatus, cancelPendingBet } from '@/lib/api'

// FC-9 attestation reportType (off-chain operator fill report): 1=FILLED, 2=FAILED, 3=PARTIAL.
const REPORT_FILLED = 1
const REPORT_FAILED = 2
const REPORT_PARTIAL = 3
// A market (FAK) order can't be recalled once authorized — it's submitted and fills synchronously, so
// offering "Cancel" during the normal in-flight window is misleading (there's nothing to stop). We only
// surface Cancel for a market bet after it's been pending this long (genuinely stuck — the operator was
// slow/unable to submit), so the user can reclaim. The backend cancel is safe regardless (it reconciles
// the true fill and never blind-FAILEDs a filled order). Resting limit orders are always cancellable.
const STUCK_PENDING_SEC = 180
import { portfolioSummaryRows, usePortfolioState, type PortfolioState } from '@/lib/accountState'

const VAULT_ADDRESS = (process.env.NEXT_PUBLIC_VAULT_ADDRESS ??
  '0x0000000000000000000000000000000000000000') as `0x${string}`

// Share counts are stored 1e6-scaled (like the on-chain order size); divide for display.
function fmtShares(scaled?: bigint): string {
  if (scaled === undefined || scaled === null) return '—'
  const n = Number(scaled) / 1e6
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

// On-chain TX links point at the PUBLIC chain explorer (Polygonscan), not our app explorer.
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? '137')
const EXPLORER_BASE =
  CHAIN_ID === 137 ? 'https://polygonscan.com' : CHAIN_ID === 80002 ? 'https://amoy.polygonscan.com' : ''
function txUrl(hash: string): string | null {
  return EXPLORER_BASE ? `${EXPLORER_BASE}/tx/${hash}` : null
}
function TxLink({ hash }: { hash?: string }) {
  if (!hash) return <>—</>
  const short = `${hash.slice(0, 10)}…${hash.slice(-8)}`
  const url = txUrl(hash)
  return url ? (
    <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--cyan)' }} title="View on Polygonscan">{short}</a>
  ) : (
    <>{short}</>
  )
}

// Paginate any list to PAGE_SIZE rows. One hook call per table (fixed count, before any early return).
const PAGE_SIZE = 10
function usePager<T>(items: T[], pageSize = PAGE_SIZE) {
  const [page, setPage] = useState(0)
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize))
  const safePage = Math.min(page, totalPages - 1)
  const pageItems = items.slice(safePage * pageSize, safePage * pageSize + pageSize)
  return { pageItems, page: safePage, setPage, totalPages }
}
// `< 1 2 … n >` page numbers: first, last, and a window around the current page, with ellipses.
function pageNumbers(current: number, total: number): (number | '…')[] {
  const want = new Set<number>([0, total - 1, current - 1, current, current + 1])
  const shown = [...want].filter((p) => p >= 0 && p < total).sort((a, b) => a - b)
  const out: (number | '…')[] = []
  let prev = -1
  for (const p of shown) {
    if (prev >= 0 && p - prev > 1) out.push('…')
    out.push(p)
    prev = p
  }
  return out
}
function PagerControls({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (p: number) => void }) {
  if (totalPages <= 1) return null
  return (
    <div className="row gap-2" style={{ justifyContent: 'flex-end', alignItems: 'center', fontSize: 11, padding: '8px 16px' }}>
      <button className="btn btn-sm btn-ghost" disabled={page === 0} onClick={() => onChange(page - 1)} aria-label="Previous page" style={{ minWidth: 28, justifyContent: 'center' }}>‹</button>
      {pageNumbers(page, totalPages).map((p, i) =>
        p === '…' ? (
          <span key={`e${i}`} style={{ color: 'var(--text-3)' }}>…</span>
        ) : (
          <button
            key={p}
            className={`btn btn-sm ${p === page ? 'btn-cyan' : 'btn-ghost'}`}
            onClick={() => onChange(p)}
            style={{ minWidth: 28, justifyContent: 'center' }}
          >
            {p + 1}
          </button>
        ),
      )}
      <button className="btn btn-sm btn-ghost" disabled={page === totalPages - 1} onClick={() => onChange(page + 1)} aria-label="Next page" style={{ minWidth: 28, justifyContent: 'center' }}>›</button>
    </div>
  )
}
// Same control, wrapped as a full-width table row so it can live inside a <tbody>.
function TablePagerRow({ page, totalPages, onChange, colSpan }: { page: number; totalPages: number; onChange: (p: number) => void; colSpan: number }) {
  if (totalPages <= 1) return null
  return (
    <tr>
      <td colSpan={colSpan} style={{ borderTop: '1px solid var(--line)' }}>
        <PagerControls page={page} totalPages={totalPages} onChange={onChange} />
      </td>
    </tr>
  )
}

// STATE-001: first-run guidance for a fresh account — one focused card with the 3-step path
// and a primary Deposit CTA, instead of six stacked empty "No X yet" tables.
function FirstRunPanel() {
  const steps: [string, string, string][] = [
    ['1', 'Deposit USDC', 'Funds enter a shared anonymity pool — not linkable to any bet you place.'],
    ['2', 'Place a private bet', 'A zero-knowledge proof authorizes the bet. Your wallet never appears on-chain.'],
    ['3', 'Settle & withdraw', 'Claim winnings and withdraw back to your own wallet, privately.'],
  ]
  return (
    <div className="panel-strong mt-4" style={{ padding: 28, maxWidth: 720, margin: '16px auto 0' }}>
      <div className="micro" style={{ color: 'var(--cyan)' }}>GET STARTED</div>
      <h3 className="h3 mt-2" style={{ margin: 0 }}>Your private vault is ready.</h3>
      <p className="body mt-2" style={{ marginTop: 8 }}>
        You haven’t deposited yet. Here’s how PolyShield works, end to end:
      </p>
      <div className="col gap-3 mt-4">
        {steps.map(([n, title, desc]) => (
          <div key={n} className="row gap-3" style={{ alignItems: 'flex-start' }}>
            <div className="center num" style={{ width: 28, height: 28, flexShrink: 0, borderRadius: '50%', border: '1px solid var(--line-strong)', fontSize: 13, color: 'var(--cyan)' }}>{n}</div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 500 }}>{title}</div>
              <div className="small mt-1" style={{ fontSize: 12 }}>{desc}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="row gap-3 mt-6">
        <Link href="/app/deposit" className="btn btn-brand" style={{ textDecoration: 'none' }}>
          <Icon d={ICONS.arrowDown} size={14} /> Deposit USDC
        </Link>
        <Link href="/app/markets" className="btn btn-ghost" style={{ textDecoration: 'none' }}>Browse markets</Link>
      </div>
    </div>
  )
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
  const { state, loading, error, refresh } = usePortfolioState(address)
  const { signMessageAsync } = useSignMessage()
  const [recovering, setRecovering] = useState(false)
  const [recoverMsg, setRecoverMsg] = useState<string | null>(null)
  // FC-13: determinate recovery progress (done / total deposits) for the restore bar.
  const [recoverProgress, setRecoverProgress] = useState<{ done: number; total: number } | null>(null)
  // FC-13: set when on-chain shows more deposits than the local cache and the master seed is
  // locked (so we can't silently sync) — surfaces a one-signature "Sync" affordance.
  const [syncAvailable, setSyncAvailable] = useState(false)
  // Receipts with a cancel in progress. Stays set from click until the row actually transitions to a
  // terminal state (the attestation poll flips it to "Reclaim stake"), so the button shows a disabled
  // "Cancelling…" the whole time — instead of snapping back to a clickable "Cancel" the moment the POST
  // returns, which made it look like nothing happened and invited repeat clicks.
  const [cancelSubmitted, setCancelSubmitted] = useState<Set<string>>(new Set())
  const setCancelling = (id: string, on: boolean) =>
    setCancelSubmitted((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  // Drives a periodic (and on-demand) re-fetch of per-bet on-chain status + operator attestation.
  // Without this the attestation poll only ran when the OPEN-RECEIPT SET changed, so a status that
  // appears later (e.g. a FAILED attestation seconds after a cancel, or a FILL) wasn't picked up until
  // a page reload — the "took a long time to update" symptom.
  const [pollTick, setPollTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setPollTick((t) => t + 1), 15_000)
    return () => window.clearInterval(id)
  }, [])
  // #5: receipt.id → resolved human-readable market name, for legacy/recovered receipts that
  // predate marketName being stored on the note. Best-effort catalog lookup; never blocks render.
  const [resolvedNames, setResolvedNames] = useState<Record<string, string>>({})

  // Cancel/recover a stuck pending bet (order never reached Polymarket, or a resting order to
  // abandon). The operator attests FAILED if there's no live order (→ reclaimable here), or
  // cancels the resting order on the CLOB and the fill tracker finalizes it (FAILED/PARTIAL).
  const handleCancelBet = async (receipt: Note) => {
    const n = (receipt.nullifier_of_bet ?? receipt.nullifier) as string
    if (!n || cancelSubmitted.has(receipt.id)) return // already cancelling — ignore repeat clicks
    setCancelling(receipt.id, true)
    try {
      const r = await cancelPendingBet(n)
      // 'finalized' (resting order cancelled + attested now) and 'failed'/'already-finalized' are all
      // immediately reclaimable; only a genuinely-still-resting 'cancel-requested' is pending.
      const reclaimableNow = r.outcome === 'failed' || r.outcome === 'already-finalized' || r.outcome === 'finalized'
      setRecoverMsg(
        reclaimableNow
          ? 'Bet cancelled — you can now reclaim your stake below.'
          : 'Cancellation requested — finishing up; the reclaim action will appear in a moment.',
      )
      await refresh()
      setPollTick((t) => t + 1) // re-fetch the bet's attestation now so the row flips without waiting for the poll
      // Stay "Cancelling…" until the row transitions to a terminal state (the poll flips it to
      // Reclaim). Safety net: if it never lands (rare), re-enable after 90s so the user can retry.
      window.setTimeout(() => setCancelling(receipt.id, false), 90_000)
    } catch (e) {
      setRecoverMsg(`Cancel failed: ${e instanceof Error ? e.message : String(e)}`)
      setCancelling(receipt.id, false) // failed → let the user retry
    }
  }

  // Rebuild the local note cache from on-chain events (FC-13 wallet-derived recovery). Needed
  // after clearing the browser cache or switching devices — the secret is never persisted, so
  // notes are re-derived from the wallet's single master-seed signature and matched against chain
  // events (one signature for the whole wallet; legacy V1 notes, if any, cost one extra each).
  // `silent` skips the user-facing messages — used by the auto-sync when the seed is already
  // unlocked so a returning user never sees a needless "Restore" prompt.
  const handleRecover = async (silent = false) => {
    if (!address || recovering) return
    setRecovering(true)
    if (!silent) setRecoverMsg(null)
    setRecoverProgress({ done: 0, total: 0 })
    try {
      // Direct-scan fallback RPC: dev hits the local chain; prod routes through the same-origin
      // /api/rpc proxy (server-only key) instead of a keyed RPC embedded in the bundle. The primary
      // path (recoverNotesViaBackend) doesn't touch this anyway.
      const rpcUrl =
        process.env.NEXT_PUBLIC_DEV_MODE === 'true'
          ? process.env.NEXT_PUBLIC_CHAIN_RPC || process.env.NEXT_PUBLIC_POLYGON_RPC || undefined
          : '/api/rpc'
      const onProgress = (done: number, total: number) => setRecoverProgress({ done, total })
      // Prefer the backend recovery data (events served from the proof-relay's index — fast, no
      // client RPC scan). Fall back to the direct on-chain scan if the backend endpoint is
      // unavailable (e.g. index not yet ready). The secret-based matching is identical either way.
      // getMasterSeed reuses an already-unlocked session seed, so an unlocked wallet adds 0 prompts.
      let recovered: Note[]
      try {
        recovered = await recoverNotesViaBackend(address, signMessageAsync, VAULT_ADDRESS, rpcUrl, undefined, undefined, onProgress, getMasterSeed)
      } catch (backendErr) {
        console.warn('[recover] backend recovery-data unavailable, falling back to chain scan:', backendErr)
        recovered = await recoverNotes(address, signMessageAsync, VAULT_ADDRESS, rpcUrl, undefined, onProgress, getMasterSeed)
      }
      const existing = new Set(getNotes().map((n) => n.id))
      let added = 0
      for (const n of recovered) {
        if (!existing.has(n.id)) { addNote(n); added++ }
      }
      setSyncAvailable(false)
      if (!silent) {
        setRecoverMsg(
          recovered.length === 0
            ? 'No notes found on-chain for this wallet.'
            : `Restored ${recovered.length} note(s) from chain (${added} new).`,
        )
      }
      await refresh()
    } catch (e) {
      if (!silent) setRecoverMsg(`Restore failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRecovering(false)
      setRecoverProgress(null)
    }
  }

  // FC-13 silent reconcile: on load, compare the wallet's on-chain deposit count (public, no
  // signature) against the local cache. If chain has more (e.g. a deposit from another device, or
  // a wiped cache) AND the master seed is already unlocked this session, auto-recover with zero
  // prompts. If the seed is locked, just surface a one-signature "Sync" affordance instead of
  // silently prompting. Note STATUS drift (settled-but-shows-pending) is already healed every poll
  // by reconcileSpentStatus in loadPortfolioState — this only covers brand-new on-chain notes.
  useEffect(() => {
    if (!address) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`/api/recovery-data/${address}`, { cache: 'no-store' })
        if (!res.ok || cancelled) return
        const data = (await res.json()) as { deposits?: unknown[] }
        const onChainDeposits = (data.deposits ?? []).length
        const localDeposits = getNotes().filter(
          (n) => n.kind === 'DEPOSIT' && n.owner_address?.toLowerCase() === address.toLowerCase(),
        ).length
        if (cancelled || onChainDeposits <= localDeposits) return
        if (hasMasterSeed(address)) {
          await handleRecover(true) // seed unlocked → silent, zero prompts
        } else {
          setSyncAvailable(true) // locked → offer a one-signature sync
        }
      } catch {
        /* backend unavailable → no-op; manual Restore remains available */
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address])

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
    // pollTick re-runs this on a 15s interval (and on demand after a cancel) so a status/attestation
    // that lands AFTER the receipts loaded (e.g. a FAILED attestation just after a cancel, or a fill)
    // is picked up without a page reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openReceiptKey, pollTick])

  // FC-14: auto-finalize partial fills. Every market buy short-fills vs the fee-naive committed
  // shares (the Polymarket taker fee), so it lands ACTIVE with a PARTIAL attestation and an inflated
  // expected_shares until partialFillCredit normalizes it (required before settlement). Run that
  // silently — the proof uses the in-memory V2 seed (no prompt) and is relayed (no wallet tx) — but
  // ONLY when the seed is already unlocked, so we never surprise the user with a signature.
  const finalizingRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!address || !hasMasterSeed(address)) return
    const receipts = state?.openReceipts ?? []
    let cancelled = false
    void (async () => {
      for (const r of receipts) {
        if (cancelled) break
        if (betOutcomes[r.id] !== REPORT_PARTIAL || betStatuses[r.id] !== BET_STATUS.ACTIVE) continue
        if (finalizingRef.current.has(r.id)) continue
        finalizingRef.current.add(r.id)
        try {
          if ((await finalizePartialFill(address, r, VAULT_ADDRESS, signMessageAsync)) && !cancelled) await refresh()
        } catch (e) {
          console.warn('[auto-finalize] partial credit failed:', e)
        } finally {
          finalizingRef.current.delete(r.id)
        }
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, betOutcomes, betStatuses])

  // #5: the conditionId of a bet — receipts carry the real one (raw_condition_id), closed-history
  // rows carry it as marketId (threaded from the bet event in accountState). Used as the catalog
  // lookup + resolvedNames key so EVERY row type (open / unfilled / lost / closed) shares one lookup.
  const cidOfNote = (n: Note): string | undefined => (n.raw_condition_id ?? n.condition_id)?.toLowerCase()
  const cidOfRow = (r: { marketId?: string }): string | undefined => r.marketId?.toLowerCase()
  const isConditionId = (s?: string): s is string => !!s && /^0x[0-9a-f]{64}$/.test(s)

  // Resolve human-readable names for any row that lacks a stored marketName (legacy notes, recovered
  // notes, older closed bets). Keyed by conditionId so one fetch covers every row in that market.
  // Fully best-effort and isolated — a slow/failed lookup never blocks the portfolio.
  useEffect(() => {
    const cids = new Set<string>()
    for (const n of [...(state?.openReceipts ?? []), ...(state?.lostBets ?? [])]) {
      const cid = cidOfNote(n)
      if (!n.marketName && isConditionId(cid) && !resolvedNames[cid]) cids.add(cid)
    }
    for (const r of state?.closedBetHistory ?? []) {
      const cid = cidOfRow(r)
      if (!r.marketName && isConditionId(cid) && !resolvedNames[cid]) cids.add(cid)
    }
    if (cids.size === 0) return
    let cancelled = false
    void (async () => {
      const entries = await Promise.all(
        [...cids].map(async (cid) => {
          try {
            // /api/market-name resolves CLOSED/ended markets too (the bettable /api/markets 404s on them).
            const res = await fetch(`/api/market-name/${cid}`, { cache: 'no-store' })
            if (!res.ok) return null
            const name = (await res.json())?.name as string | undefined
            return name ? ([cid, name] as const) : null
          } catch {
            return null
          }
        }),
      )
      if (!cancelled) {
        const found = entries.filter((e): e is readonly [string, string] => e !== null)
        if (found.length > 0) setResolvedNames((prev) => ({ ...prev, ...Object.fromEntries(found) }))
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Display label for a bet row: prefer the question captured at bet time, then a resolved catalog
  // name (by conditionId), and only fall back to the opaque id if neither is available.
  const marketLabel = (r: Note): string => {
    const cid = cidOfNote(r)
    return r.marketName ?? (cid ? resolvedNames[cid] : undefined) ?? r.marketId ?? r.id
  }
  const closedLabel = (r: { marketName?: string; marketId?: string; id: string }): string => {
    const cid = cidOfRow(r)
    return r.marketName ?? (cid ? resolvedNames[cid] : undefined) ?? r.marketId ?? r.id
  }

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
    const isPartialAttest = outcome === REPORT_PARTIAL && !onchainFilled
    // A market buy spends the WHOLE stake (shares + Polymarket taker fee), so it gets a PARTIAL
    // attestation even though there's nothing to refund — the fee just bought slightly fewer shares
    // than the fee-naive committed estimate. Such a "fee-only" partial (spent ≥ stake → refund 0) is a
    // FILLED position from the user's view, so show it as FILLED instead of a confusing "$0 Claim
    // refund". (The silent auto-finalize still normalizes the on-chain record once the seed is unlocked
    // — e.g. at settle time — so settlement stays correct.) Only a GENUINE partial (real unfilled
    // remainder, refund > 0) keeps the "Claim refund" action.
    const fill = betFills[receipt.id]
    const feeOnlyFill =
      isPartialAttest && !!fill && (receipt.bet_amount ?? 0n) > 0n && fill.spent >= (receipt.bet_amount ?? 0n)
    const isPartial = isPartialAttest && !feeOnlyFill
    const isFailed = outcome === REPORT_FAILED
    const isFilled = outcome === REPORT_FILLED || onchainFilled || feeOnlyFill
    return { ready, isPartial, isFailed, isFilled, isPosition: ready || isFilled || isPartial }
  }
  const visibleReceipts = (state?.openReceipts ?? []).filter((r) => !lostBetIds.has(r.id))
  // Every section is sorted newest-first by creation time, then paginated to 10 rows. The pager hooks
  // are called unconditionally here (fixed count) so they run before the `!address` early return.
  const byNewest = <T extends { createdAt?: number }>(a: T[]): T[] =>
    [...a].sort((x, y) => (y.createdAt ?? 0) - (x.createdAt ?? 0))
  const openPositions = byNewest(visibleReceipts.filter((r) => classify(r).isPosition))
  const openOrders = byNewest(visibleReceipts.filter((r) => !classify(r).isPosition))
  const readyToSettleSorted = [...(state?.readyToSettle ?? [])].sort(
    (a, b) => (b.receipt.createdAt ?? 0) - (a.receipt.createdAt ?? 0),
  )
  // Closed box merges lost positions (Notes) and settled/refunded history (activity rows) into one
  // date-sorted list so the 10-per-page view is chronological across both.
  type ClosedRow =
    | { kind: 'lost'; createdAt: number; note: Note }
    | { kind: 'history'; createdAt: number; row: PortfolioState['closedBetHistory'][number] }
  const closedRows: ClosedRow[] = byNewest<ClosedRow>([
    ...(state?.lostBets ?? []).map((n) => ({ kind: 'lost' as const, createdAt: n.createdAt, note: n })),
    ...(state?.closedBetHistory ?? []).map((r) => ({ kind: 'history' as const, createdAt: r.createdAt, row: r })),
  ])
  const depositsSorted = byNewest(state?.depositHistory ?? [])
  const withdrawalsSorted = byNewest(state?.withdrawalHistory ?? [])

  // STATE-001: a brand-new account (no deposits, no bets, no history) gets a single guiding
  // first-run card instead of six stacked empty tables. Any activity flips to the full layout.
  const hasActivity =
    (state?.openReceipts.length ?? 0) > 0 ||
    (state?.closedBetHistory.length ?? 0) > 0 ||
    (state?.lostBets.length ?? 0) > 0 ||
    (state?.depositHistory.length ?? 0) > 0 ||
    (state?.withdrawalHistory.length ?? 0) > 0

  const positionsPager = usePager(openPositions)
  const ordersPager = usePager(openOrders)
  const readyPager = usePager(readyToSettleSorted)
  const closedPager = usePager(closedRows)
  const depositsPager = usePager(depositsSorted)
  const withdrawalsPager = usePager(withdrawalsSorted)

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
    // Show the ACTUAL shares held whenever the operator reported a fill (covers both genuine partials
    // and fee-only fills shown as FILLED); otherwise the committed estimate.
    const heldShares = fill && fill.filled > 0n ? fill.filled : expected
    const fillLabel = isFilled
      ? '100%'
      : isFailed
        ? '0%'
        : isPartial && fill && expected > 0n
          ? `${(Number((fill.filled * 1000n) / expected) / 10).toFixed(1)}%`
          : '—'
    return (
      <tr key={receipt.id}>
        <td title={receipt.marketId ?? receipt.id}>{marketLabel(receipt)}</td>
        <td>{receipt.sideLabel ?? receipt.side ?? '—'}</td>
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
            (() => {
              const isCancelling = cancelSubmitted.has(receipt.id)
              // A live RESTING limit order is genuinely on the book → always cancellable. A market
              // (FAK) order fills synchronously and can't be recalled, so only offer Cancel once it's
              // been pending long enough to be considered stuck (operator slow/unable to submit).
              const isResting = betStatuses[receipt.id] === BET_STATUS.RESTING
              const ageSec = receipt.createdAt ? Math.max(0, Math.floor(Date.now() / 1000) - receipt.createdAt) : 0
              const stuck = ageSec >= STUCK_PENDING_SEC
              const cancellable = !isFilled && (isResting || stuck)
              const waitingLabel = isFilled
                ? '—'
                : isResting
                  ? 'Resting limit order'
                  : isCancelling
                    ? 'Cancelling — please wait…'
                    : stuck
                      ? 'Taking longer than expected'
                      : 'Submitting…'
              return (
                <div className="row gap-2" style={{ justifyContent: 'flex-end', alignItems: 'center' }}>
                  <span className="small" style={{ fontSize: 10, color: 'var(--text-3)' }}>
                    {waitingLabel}
                  </span>
                  {cancellable && (
                    <button
                      className="btn btn-sm"
                      disabled={isCancelling}
                      title={isResting ? 'Cancel this resting limit order and reclaim your stake' : 'Cancel this stuck bet and reclaim your stake'}
                      onClick={() => void handleCancelBet(receipt)}
                    >
                      {isCancelling ? 'Cancelling…' : 'Cancel'}
                    </button>
                  )}
                </div>
              )
            })()
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
            className={`btn btn-sm${syncAvailable ? ' btn-primary' : ''}`}
            title="Re-derive your notes from on-chain events (after a cache clear or new device). One wallet signature for the whole wallet (FC-13 master seed)."
          >
            <Icon d={ICONS.search} size={12} />{' '}
            {recovering
              ? recoverProgress && recoverProgress.total > 0
                ? `Restoring ${recoverProgress.done}/${recoverProgress.total}…`
                : 'Restoring…'
              : syncAvailable
                ? 'Sync from chain'
                : 'Restore from chain'}
          </button>
          <Link href="/app/deposit" className="btn btn-sm" style={{ textDecoration: 'none' }}>
            <Icon d={ICONS.arrowDown} size={12} /> Deposit
          </Link>
          <Link href="/app/withdraw" className="btn btn-sm btn-primary" style={{ textDecoration: 'none' }}>
            <Icon d={ICONS.withdraw} size={12} /> Withdraw
          </Link>
        </div>
      </div>
      {syncAvailable && !recovering && (
        <div className="row" style={{ padding: '8px 24px', fontSize: 12, color: 'var(--text-2)' }}>
          New on-chain activity detected for this wallet. Click “Sync from chain” (one signature) to update your view.
        </div>
      )}
      {recoverMsg && (
        <div className="row" style={{ padding: '8px 24px', fontSize: 12, color: 'var(--text-2)' }}>{recoverMsg}</div>
      )}
      {/* WCAG 4.1.3 — recovery runs for many seconds and its count/result lives in the button text;
          announce progress + the final result (incl. "found nothing") to assistive tech. */}
      <LiveRegion
        message={
          recovering
            ? recoverProgress && recoverProgress.total > 0
              ? `Restoring ${recoverProgress.done} of ${recoverProgress.total} notes…`
              : 'Restoring notes from chain…'
            : recoverMsg || ''
        }
      />

      <div style={{ padding: 24 }}>
        {loading && !state && (
          <div className="panel" style={{ padding: 16, marginBottom: 16, color: 'var(--text-2)' }}>
            Loading portfolio state...
          </div>
        )}

        {!loading && !state && error && (
          <div className="panel" style={{ padding: 16, marginBottom: 16, borderColor: 'var(--red)' }}>
            <div className="small" style={{ color: 'var(--red)', fontSize: 12 }}>
              Couldn’t load your portfolio: {error}
            </div>
            <button className="btn btn-sm mt-2" onClick={() => void refresh()}>Retry</button>
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

            {!hasActivity ? (
              <FirstRunPanel />
            ) : (
            <>
            {/* Positions = bets that actually filled (you hold shares): settle / close / claim. */}
            <div className="panel mt-4 scroll-x" style={{ padding: 0, overflowX: 'auto' }}>
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
                  {positionsPager.pageItems.map(renderReceiptRow)}
                  <TablePagerRow page={positionsPager.page} totalPages={positionsPager.totalPages} onChange={positionsPager.setPage} colSpan={7} />
                </tbody>
              </table>
            </div>

            {/* Orders = bets not (yet) filled — resting limit orders and expired/unfilled orders. */}
            <div className="panel mt-4 scroll-x" style={{ padding: 0, overflowX: 'auto' }}>
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
                  {ordersPager.pageItems.map(renderReceiptRow)}
                  <TablePagerRow page={ordersPager.page} totalPages={ordersPager.totalPages} onChange={ordersPager.setPage} colSpan={7} />
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
                  {readyPager.pageItems.map((row) => (
                    <div key={row.receipt.id} className="row" style={{ justifyContent: 'space-between', gap: 12, padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 6 }}>
                      <div>
                        <div style={{ fontSize: 13 }}>{marketLabel(row.receipt)}</div>
                        <div className="small" style={{ fontSize: 11 }}>
                          Amount ${formatUsdc(row.receipt.bet_amount ?? row.receipt.balance)} · payout/share {row.payoutPerShare.toString()}
                        </div>
                      </div>
                      <div className="num" style={{ color: 'var(--green)' }}>+${formatUsdc(row.claimAmount)}</div>
                    </div>
                  ))}
                  <PagerControls page={readyPager.page} totalPages={readyPager.totalPages} onChange={readyPager.setPage} />
                </div>
              )}
            </div>

            <div className="panel mt-4 scroll-x" style={{ padding: 0, overflowX: 'auto' }}>
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
                  {closedPager.pageItems.map((item) =>
                    item.kind === 'lost' ? (
                      <tr key={item.note.id}>
                        <td title={item.note.marketId ?? item.note.id}>{marketLabel(item.note)}</td>
                        <td>{item.note.sideLabel ?? item.note.side ?? '—'}</td>
                        <td className="num" style={{ textAlign: 'right' }}>${formatUsdc(item.note.bet_amount ?? item.note.balance)}</td>
                        <td className="num" style={{ textAlign: 'right', color: 'var(--text-3)' }}>—</td>
                        <td className="num" style={{ textAlign: 'right', color: 'var(--red)' }}>
                          −${formatUsdc(item.note.bet_amount ?? item.note.balance)}
                        </td>
                        <td className="small">{formatDate(item.note.createdAt)}</td>
                      </tr>
                    ) : (
                      <tr key={item.row.id}>
                        <td title={item.row.marketId ?? item.row.id}>{closedLabel(item.row)}</td>
                        <td>{item.row.side ?? '—'}</td>
                        <td className="num" style={{ textAlign: 'right' }}>${formatUsdc(item.row.betAmount)}</td>
                        <td className="num" style={{ textAlign: 'right' }}>${formatUsdc(item.row.amount)}</td>
                        <td className="num" style={{ textAlign: 'right', color: item.row.pnl >= 0n ? 'var(--green)' : 'var(--red)' }}>
                          {item.row.pnl >= 0n ? '+' : '−'}${formatUsdc(item.row.pnl >= 0n ? item.row.pnl : -item.row.pnl)}
                        </td>
                        <td className="small">{formatDate(item.row.createdAt)}</td>
                      </tr>
                    ),
                  )}
                  <TablePagerRow page={closedPager.page} totalPages={closedPager.totalPages} onChange={closedPager.setPage} colSpan={6} />
                </tbody>
              </table>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, marginTop: 16 }}>
              <div className="panel scroll-x" style={{ padding: 0, overflowX: 'auto' }}>
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
                    {depositsPager.pageItems.map((row) => (
                      <tr key={row.id}>
                        <td className="num">${formatUsdc(row.amount)}</td>
                        <td className="small">{formatDate(row.createdAt)}</td>
                        <td className="mono small"><TxLink hash={row.txHash} /></td>
                      </tr>
                    ))}
                    <TablePagerRow page={depositsPager.page} totalPages={depositsPager.totalPages} onChange={depositsPager.setPage} colSpan={3} />
                  </tbody>
                </table>
              </div>

              <div className="panel scroll-x" style={{ padding: 0, overflowX: 'auto' }}>
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
                    {withdrawalsPager.pageItems.map((row) => (
                      <tr key={row.id}>
                        <td className="num">${formatUsdc(row.amount)}</td>
                        <td className="small">Your wallet</td>
                        <td className="small">{formatDate(row.createdAt)}</td>
                        <td className="mono small"><TxLink hash={row.txHash} /></td>
                      </tr>
                    ))}
                    <TablePagerRow page={withdrawalsPager.page} totalPages={withdrawalsPager.totalPages} onChange={withdrawalsPager.setPage} colSpan={4} />
                  </tbody>
                </table>
              </div>
            </div>
            </>
            )}
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
