'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { useBlockNumber, useDisconnect, usePublicClient } from 'wagmi'
import { fetchPendingCredit, fetchMarketResolvedAt, fetchBetStatus, fetchAttestation, fetchBetRecord, BET_STATUS } from '@/lib/api'
import { classifyReceipt } from '@/lib/betClassify'

// FC-9 attestation reportType: a bet that actually filled has a FILLED (1) attestation.
const REPORT_FILLED = 1
// FC-9 attestation reportType: a position the operator has SOLD (close fill) carries a SOLD (4)
// attestation whose proceeds (amountA) are reclaimable via a position_close credit proof.
const REPORT_SOLD = 4
const REPORT_PARTIAL = 3
import {
  formatUsdc,
  getCashBalance,
  getCurrentCashNote,
  getOpenBetReceipts,
  getWalletNotes,
  getWalletActivity,
  getLastSeenBlock,
  setLastSeenBlock,
  getChainFingerprint,
  setChainFingerprint,
  resetAllLocalState,
  receiptCircuitKey,
  reconcileSpentStatus,
  type Note,
  type WalletActivityEvent,
  type ReadyToSettleBet,
} from '@/lib/notes'

const VAULT_ADDRESS = (process.env.NEXT_PUBLIC_VAULT_ADDRESS ??
  '0x0000000000000000000000000000000000000000') as `0x${string}`

export interface PortfolioState {
  notes: Note[]
  cashNote: Note | null
  cashBalance: bigint
  openReceipts: Note[]
  readyToSettle: ReadyToSettleBet[]
  lostBets: Note[]
  // BUG 1: never-filled orders whose market has resolved — reclaimable now (shown with an immediate
  // reclaim action rather than stuck "pending"). Still members of openReceipts.
  unfilledResolved: Note[]
  totalBalance: bigint
  totalOpenExposure: bigint
  totalDeposited: bigint
  totalWithdrawn: bigint
  totalPnL: bigint
  // H4: capital that is recoverable RIGHT NOW but needs the user to submit a proof — it is
  // already counted in totalBalance/totalOpenExposure but isn't spendable until reclaimed. Sum of
  // (a) reclaimable stakes (FAILED-attested / unfilled-resolved orders → bet-cancel/cancel credit),
  // (b) sold-but-not-credited proceeds (SOLD attestation → position-close credit), and
  // (c) pending partial-fill refunds (PARTIAL attestation unfilled remainder → partial-fill credit).
  // None of these are in cashBalance, so they don't double-count it. actionNeededCount is the number
  // of receipts contributing.
  actionNeededTotal: bigint
  actionNeededCount: number
  depositHistory: WalletActivityEvent[]
  withdrawalHistory: WalletActivityEvent[]
  closedBetHistory: Array<WalletActivityEvent & { betAmount: bigint; pnl: bigint }>
}

type SettlementStatus =
  | { kind: 'ready'; payoutPerShare: bigint; claimAmount: bigint }
  | { kind: 'lost' }
  | { kind: 'pending' }
  // BUG 1: a never-filled order whose market has RESOLVED — it can never fill, so it's not "pending"
  // forever; it's immediately reclaimable (reclaim/refund path, not settlement).
  | { kind: 'unfilled-resolved' }

/**
 * Did this bet actually fill (i.e. does the depositor hold shares)? A market-order fill stays
 * ACTIVE on-chain but carries a FILLED operator attestation; a post-partial bet is on-chain
 * FILLED. A resting/expired/unfilled order has neither — it holds no shares.
 */
async function betDidFill(nullifierOfBet: `0x${string}`): Promise<boolean> {
  try {
    const status = await fetchBetStatus(VAULT_ADDRESS, nullifierOfBet)
    if (status === BET_STATUS.FILLED) return true
    const att = await fetchAttestation(nullifierOfBet) // bet-outcome attestation
    return !!att && att.reportType === REPORT_FILLED
  } catch {
    return false
  }
}

async function checkSettlementStatus(receipt: Note): Promise<SettlementStatus> {
  if (!receipt.expectedShares) return { kind: 'pending' }
  const circuitKey = receiptCircuitKey(receipt)
  if (!circuitKey) return { kind: 'pending' }
  // Gate on ACTUAL fill: an unfilled/resting order holds no shares and must NEVER settle as a
  // winning position — otherwise a resolved market makes it show a phantom profit (and the
  // on-chain creditSettlement would revert for lack of a FILLED attestation anyway). An
  // unfilled order is recovered via the reclaim/refund path, not settlement.
  const nullifierOfBet = (receipt.nullifier_of_bet ?? receipt.nullifier) as `0x${string}`
  try {
    // Gate on ACTUAL fill: an unfilled/resting order holds no shares and must NEVER settle.
    if (!(await betDidFill(nullifierOfBet))) {
      // BUG 1: if the market has already RESOLVED, this order can never fill — surface it as
      // reclaimable immediately instead of leaving it "pending" forever (the operator won't attest a
      // never-submitted order on its own, so the user must reclaim). Still pending if unresolved.
      const resolvedAt = await fetchMarketResolvedAt(VAULT_ADDRESS, circuitKey)
      if (resolvedAt > 0n) return { kind: 'unfilled-resolved' }
      return { kind: 'pending' }
    }

    // The AUTHORITATIVE on-chain record decides settleability — NOT the FILLED attestation alone. A bet
    // that filled and was then closed (CLOSING/CLOSED_CREDITED), already settled (CREDITED), or reclaimed
    // (FAILED/CANCELLED_CREDITED) STILL carries its original FILLED attestation, so betDidFill() is true
    // for it. Only a still-open filled position is settleable: FILLED, PARTIAL_FILLED, or ACTIVE
    // (market-order fills stay ACTIVE on-chain but are gated to a real fill by betDidFill). A partial
    // close keeps status FILLED with sold_shares > 0, so its UNSOLD remainder still settles.
    const rec = await fetchBetRecord(VAULT_ADDRESS, nullifierOfBet)
    const settleable =
      rec.status === BET_STATUS.FILLED ||
      rec.status === BET_STATUS.PARTIAL_FILLED ||
      rec.status === BET_STATUS.ACTIVE
    if (!settleable) return { kind: 'pending' }
    const remaining = rec.expectedShares > rec.soldShares ? rec.expectedShares - rec.soldShares : 0n
    if (remaining <= 0n) return { kind: 'pending' } // nothing left to settle (e.g. fully closed)

    const outcomeSide = receipt.side === 'NO' ? 1 : 0
    const payoutPerShare = await fetchPendingCredit(VAULT_ADDRESS, circuitKey, outcomeSide)
    if (payoutPerShare > 0n) {
      return { kind: 'ready', payoutPerShare, claimAmount: remaining * payoutPerShare }
    }
    // payout = 0: unresolved OR user's side lost — check resolvedAt to distinguish
    const resolvedAt = await fetchMarketResolvedAt(VAULT_ADDRESS, circuitKey)
    if (resolvedAt > 0n) return { kind: 'lost' }
    return { kind: 'pending' }
  } catch {
    // An on-chain read failed even after ethCall's retries (RPC unreachable / sustained rate-limit).
    // Treat conservatively as PENDING — NEVER fabricate ready/lost from a failed read (that was the
    // bug that flipped a resolved bet to "pending"/"lost" on a transient 429). The next poll recovers.
    return { kind: 'pending' }
  }
}

async function buildReadyToSettle(receipts: Note[]): Promise<{ ready: ReadyToSettleBet[]; lost: Note[]; unfilledResolved: Note[] }> {
  const results = await Promise.all(receipts.map(async (receipt) => ({ receipt, status: await checkSettlementStatus(receipt) })))
  const ready: ReadyToSettleBet[] = []
  const lost: Note[] = []
  const unfilledResolved: Note[] = []
  for (const { receipt, status } of results) {
    if (status.kind === 'ready') {
      ready.push({ receipt, payoutPerShare: status.payoutPerShare, claimAmount: status.claimAmount } satisfies ReadyToSettleBet)
    } else if (status.kind === 'lost') {
      lost.push(receipt)
    } else if (status.kind === 'unfilled-resolved') {
      unfilledResolved.push(receipt)
    }
  }
  return { ready, lost, unfilledResolved }
}

/**
 * H4: total capital that is recoverable now but needs a user-submitted proof, plus the count of
 * receipts contributing. This sums the SAME receipts the portfolio's per-row Reclaim/Claim/Credit
 * buttons key off — it invents no new on-chain logic, only reads the same status + attestation the
 * page already reads (fetchBetStatus / fetchAttestation) and runs them through the shared
 * classifyReceipt rulebook. Three addends, none of which are in cashBalance (so no double-count):
 *   1. reclaimable stakes — a FAILED-attested order (bet-cancel credit) or an unfilled order whose
 *      market already resolved (cancel credit); the full bet_amount is recoverable.
 *   2. sold-but-not-credited proceeds — a SOLD attestation is present (position closed/sold) but the
 *      close credit hasn't landed; the proceeds (amountA) are recoverable.
 *   3. pending partial-fill refunds — a genuine PARTIAL attestation leaves bet_amount − spent as a
 *      refundable remainder (partial-fill credit).
 * Best-effort per receipt: an RPC failure for one receipt simply contributes 0 (never throws).
 */
async function buildActionNeeded(
  receipts: Note[],
  unfilledResolved: Note[],
): Promise<{ total: bigint; count: number }> {
  const unfilledIds = new Set(unfilledResolved.map((n) => n.id))
  const per = await Promise.all(
    receipts.map(async (receipt): Promise<bigint> => {
      const n = (receipt.nullifier_of_bet ?? receipt.nullifier) as `0x${string}`
      try {
        let status = -1
        try { status = await fetchBetStatus(VAULT_ADDRESS, n) } catch { /* leave -1 */ }
        // A terminal on-chain status means the capital is already credited/settled and back in
        // cashBalance — never count it as "action needed" (avoids double-counting a SOLD/FAILED
        // attestation that lingers after its credit). Only ACTIVE/FILLED/PARTIAL_FILLED/RESTING/
        // CLOSING positions can still be awaiting a user proof.
        const terminal =
          status === BET_STATUS.CREDITED ||
          status === BET_STATUS.CANCELLED_CREDITED ||
          status === BET_STATUS.CLOSED_CREDITED ||
          status === BET_STATUS.FAILED
        if (terminal) return 0n
        // Sold-but-not-credited: a SOLD attestation means the position was closed/sold and its
        // proceeds are reclaimable via the close credit (the credit hasn't landed — status isn't
        // terminal). For a SOLD attestation amountB is the proceeds (micro-USDC) and amountA is
        // sold_shares — matches finalizeClose.ts (Vault injects amountB as sell_proceeds).
        const sold = await fetchAttestation(n, REPORT_SOLD)
        if (sold) return BigInt(sold.amountB)
        // Outcome attestation drives FAILED / PARTIAL only while the bet is still open on-chain.
        let outcome = 0
        let fill: { filled: bigint; spent: bigint } | undefined
        if (status === BET_STATUS.ACTIVE || status === BET_STATUS.RESTING) {
          const att = await fetchAttestation(n)
          outcome = att ? att.reportType : 0
          if (att && att.reportType === REPORT_PARTIAL) {
            fill = { filled: BigInt(att.amountA), spent: BigInt(att.amountB) }
          }
        }
        const betAmount = receipt.bet_amount ?? receipt.balance ?? 0n
        const cls = classifyReceipt({ status, outcome, betAmount, fill })
        // Reclaimable stake: a FAILED-attested order, or an unfilled order whose market resolved
        // (surfaced by buildReadyToSettle). Either way the whole stake is recoverable.
        if (cls.isFailed || unfilledIds.has(receipt.id)) return betAmount
        // Pending partial-fill refund: the unfilled remainder (bet_amount − spent).
        if (cls.isPartial && fill) {
          const refund = betAmount > fill.spent ? betAmount - fill.spent : 0n
          return refund
        }
        return 0n
      } catch {
        return 0n
      }
    }),
  )
  let total = 0n
  let count = 0
  for (const v of per) {
    if (v > 0n) { total += v; count++ }
  }
  return { total, count }
}

export async function loadPortfolioState(wallet: `0x${string}`): Promise<PortfolioState> {
  // Chain-authoritative spent reconciliation: heal any local note whose nullifier is already spent
  // on-chain BEFORE computing balances/cash-note, so the displayed balance and the note selection
  // are correct without the user ever running "Restore". Best-effort: tolerant of RPC errors.
  await reconcileSpentStatus(wallet).catch(() => undefined)
  const notes = getWalletNotes(wallet)
  const cashNote = getCurrentCashNote(wallet)
  const cashBalance = getCashBalance(wallet)
  const openReceipts = getOpenBetReceipts(wallet)
  const activity = getWalletActivity(wallet)
  const { ready: readyToSettle, lost: lostBets, unfilledResolved } = await buildReadyToSettle(openReceipts)
  // H4: how much of the displayed balance the user must submit a proof to recover.
  const { total: actionNeededTotal, count: actionNeededCount } = await buildActionNeeded(openReceipts, unfilledResolved)
  // Exclude lost bets from "open" exposure — they're already shown in closed bets
  const lostBetIds = new Set(lostBets.map((n) => n.id))
  const totalOpenExposure = openReceipts
    .filter((n) => !lostBetIds.has(n.id))
    .reduce((sum, note) => sum + (note.bet_amount ?? note.balance), 0n)
  const depositHistory = activity.filter((event) => event.kind === 'deposit')
  const withdrawalHistory = activity.filter((event) => event.kind === 'withdrawal')
  const betEvents = activity.filter((event) => event.kind === 'bet')
  const settlementEvents = activity.filter((event) => event.kind === 'settlement')
  const refundEvents = activity.filter((event) => event.kind === 'refund')

  // The bet event carries the readable market name + the resolvable conditionId; thread both into the
  // closed row so it shows a name instead of an opaque id (the settlement/refund event lacks them).
  const betFor = (receiptId?: string) =>
    receiptId ? betEvents.find((bet) => bet.receiptId === receiptId) : undefined
  const closedBetHistory = settlementEvents.map((event) => {
    const betEvent = betFor(event.receiptId)
    const committed = betEvent?.amount ?? 0n
    // Effective cost basis = committed stake − partial-fill refunds already returned for this
    // receipt. A partial fill returns the unfilled remainder, so the SETTLED position truly cost
    // `spent` (= committed − refunded), not the committed stake. Netting here makes
    // P&L = settlement − spent instead of overstating the cost (and understating the gain). A bet
    // with no partial has refunded = 0, so this is unchanged for the common case.
    const refunded = refundEvents
      .filter((r) => r.receiptId && r.receiptId === event.receiptId)
      .reduce((sum, r) => sum + r.amount, 0n)
    const betAmount = committed > refunded ? committed - refunded : committed
    const pnl = event.amount - betAmount
    return {
      ...event,
      betAmount,
      pnl,
      marketName: event.marketName ?? betEvent?.marketName,
      marketId: betEvent?.marketId ?? event.marketId,
    }
  }).concat(
    // A refund returns the user's OWN stake — the unfilled remainder of a partial fill, or the
    // full stake of a failed bet — so it is a CAPITAL RETURN, not a gain/loss: P&L is 0. (The
    // earlier `amount − betAmount` booked a partial-fill refund as a phantom loss, which L3 makes
    // common since downsized market orders now refund the unfilled part; the still-open filled portion
    // settles separately for the real P&L. Exact cost-basis netting of a partial-then-settled bet —
    // crediting the settlement against `spent` rather than the committed stake — is an FC-5 follow-up.)
    refundEvents.map((event) => {
      const betEvent = betFor(event.receiptId)
      const betAmount = betEvent?.amount ?? 0n
      return {
        ...event,
        betAmount,
        pnl: 0n,
        marketName: event.marketName ?? betEvent?.marketName,
        marketId: betEvent?.marketId ?? event.marketId,
      }
    }),
  )

  const totalDeposited = depositHistory.reduce((sum, event) => sum + event.amount, 0n)
  const totalWithdrawn = withdrawalHistory.reduce((sum, event) => sum + event.amount, 0n)
  // Include unacknowledged lost bets as negative P&L immediately — don't wait for the on-chain close proof
  const lostBetPnL = lostBets.reduce((sum, r) => sum - (r.bet_amount ?? r.balance), 0n)
  const totalPnL = closedBetHistory.reduce((sum, event) => sum + event.pnl, 0n) + lostBetPnL

  return {
    notes,
    cashNote,
    cashBalance,
    openReceipts,
    readyToSettle,
    lostBets,
    unfilledResolved,
    totalBalance: cashBalance + totalOpenExposure,
    totalOpenExposure,
    totalDeposited,
    totalWithdrawn,
    totalPnL,
    actionNeededTotal,
    actionNeededCount,
    depositHistory,
    withdrawalHistory,
    closedBetHistory,
  }
}

export function usePortfolioState(wallet?: `0x${string}`): {
  state: PortfolioState | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
} {
  const [state, setState] = useState<PortfolioState | null>(null)
  const [loading, setLoading] = useState(true)
  // Surface load failures instead of silently leaving the page blank (a thrown
  // loadPortfolioState used to leave state=null with no UI — the "only the nav bar renders" bug).
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!wallet) {
      setState(null)
      setLoading(false)
      return
    }

    setLoading(true)
    try {
      const next = await loadPortfolioState(wallet)
      setState(next)
      setError(null)
    } catch (e) {
      console.error('[portfolio] loadPortfolioState failed:', e)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [wallet])

  useEffect(() => {
    void refresh()
    if (!wallet) return

    const id = window.setInterval(() => {
      void refresh()
    }, 15_000)

    // Refresh immediately whenever notes are added/spent so the TopNav balance
    // and portfolio page update without waiting for the next 15-second poll.
    window.addEventListener('polyshield:notes-changed', refresh as EventListener)

    return () => {
      window.clearInterval(id)
      window.removeEventListener('polyshield:notes-changed', refresh as EventListener)
    }
  }, [wallet, refresh])

  return { state, loading, error, refresh }
}

/**
 * Detects when the local dev chain (Anvil) has been reset by watching for the
 * block number to drop below the last-seen block. On reset, wipes all locally
 * cached protocol state (notes, activity, deposit indices) so the portfolio
 * shows a clean slate instead of stale data from the previous run.
 *
 * Mount this hook once in the app root layout. It is a no-op when the block
 * number is increasing normally.
 *
 * Returns true when a reset was just detected (callers can show a toast).
 */
export function useChainResetDetector(): boolean {
  const [justReset, setJustReset] = useState(false)
  // Chain resets only happen on the local dev chain (Anvil reseeds on every `dev:mock`). On Polygon
  // the height never goes backwards, so block-watching there is pure wasted RPC. Gate the poll to dev
  // AND pause it while the tab is hidden — a background tab needn't poll at all. (The genesis-hash
  // check below is the primary reset signal and runs once via publicClient regardless.)
  const isDev = process.env.NEXT_PUBLIC_DEV_MODE === 'true'
  const [tabVisible, setTabVisible] = useState(true)
  useEffect(() => {
    if (typeof document === 'undefined') return
    const onVis = () => setTabVisible(!document.hidden)
    onVis()
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])
  const watchActive = isDev && tabVisible
  const { data: blockNumber } = useBlockNumber({
    watch: watchActive,
    query: { enabled: isDev, refetchInterval: watchActive ? 12000 : (false as const) },
  })
  const { disconnect } = useDisconnect()
  const publicClient = usePublicClient()
  const justResetRef = useRef(false)

  const handleReset = useCallback(() => {
    // Clear all local protocol state AND disconnect the wallet so the user reconnects
    // clean (prevents stale account/nonce state in the wallet provider).
    resetAllLocalState()
    disconnect()
    if (!justResetRef.current) {
      justResetRef.current = true
      setJustReset(true)
      // Auto-clear the flag after the UI has had time to show a banner
      window.setTimeout(() => {
        justResetRef.current = false
        setJustReset(false)
      }, 5000)
    }
  }, [disconnect])

  // Primary, robust signal: the genesis block hash. Anvil reseeds the genesis timestamp
  // from the wall clock on every `dev:mock` restart, so a changed hash means a fresh chain
  // — detected reliably even when the new chain's height already exceeds last-seen (the case
  // the block-number-decrease check below misses).
  useEffect(() => {
    if (!publicClient) return
    let cancelled = false
    void (async () => {
      try {
        const genesis = await publicClient.getBlock({ blockNumber: 0n })
        if (cancelled || !genesis.hash) return
        const stored = getChainFingerprint()
        if (stored && stored !== genesis.hash) {
          handleReset()
        }
        // Record (or refresh) the fingerprint for the now-current chain.
        setChainFingerprint(genesis.hash)
      } catch {
        /* RPC unavailable — fall back to the block-number heuristic below */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [publicClient, handleReset])

  // Secondary signal: block number going backwards — a DEV/Anvil-reset heuristic ONLY.
  // On mainnet the RPC is load-balanced (publicnode), so a poll can transiently hit a node a
  // few blocks behind and report a LOWER block than last-seen. That is NOT a chain reset, and
  // wiping local state + disconnecting on it caused the portfolio to vanish spuriously. So:
  // (1) gate to dev mode (mainnet never resets — the genesis-hash check above covers dev), and
  // (2) require a large drop so even dev-RPC jitter can't false-trigger (Anvil resets to 0,
  //     a huge drop). The fingerprint check remains the authoritative signal.
  useEffect(() => {
    if (blockNumber === undefined) return
    const isDev = process.env.NEXT_PUBLIC_DEV_MODE === 'true'
    const current = Number(blockNumber)
    const last = getLastSeenBlock()

    if (isDev && last > 0 && current < last - 100) {
      handleReset()
    }

    if (current > last) {
      setLastSeenBlock(current)
    }
  }, [blockNumber, handleReset])

  return justReset
}

// A summary tile. `tone` colors the value: 'pos' green, 'neg' red, undefined neutral. When `tone`
// is set the `value` must already carry its own sign + '$' in the right order (e.g. '+$5.00' /
// '−$5.00'), since formatUsdc would otherwise put the minus INSIDE the dollar sign ('$-5.00').
export interface PortfolioSummaryRow {
  label: string
  value: string
  note: string
  tone?: 'pos' | 'neg'
}

export function portfolioSummaryRows(state: PortfolioState): PortfolioSummaryRow[] {
  // P&L: format the magnitude and prepend the sign OUTSIDE the '$' so a loss reads '−$50.00' (not
  // '$-50.00'), matching the closed-bets table cell. Zero is shown neutral as '+$0.00' (no red).
  const pnl = state.totalPnL
  const pnlAbs = pnl >= 0n ? pnl : -pnl
  return [
    { label: 'Total balance', value: `$${formatUsdc(state.totalBalance)}`, note: 'Cash plus capital locked in open bets' },
    { label: 'Cash', value: `$${formatUsdc(state.cashBalance)}`, note: 'Available right now for a new bet or withdrawal' },
    { label: 'Deposited', value: `$${formatUsdc(state.totalDeposited)}`, note: 'Cumulative USDC put into the vault' },
    { label: 'Withdrawn', value: `$${formatUsdc(state.totalWithdrawn)}`, note: 'Cumulative USDC sent back to your wallet' },
    {
      label: 'P&L',
      value: `${pnl >= 0n ? '+' : '−'}$${formatUsdc(pnlAbs)}`,
      note: 'Settled gains minus losses',
      tone: pnl >= 0n ? 'pos' : 'neg',
    },
  ]
}
