'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { useBlockNumber, useDisconnect, usePublicClient } from 'wagmi'
import { fetchPendingCredit, fetchMarketResolvedAt, fetchBetStatus, fetchAttestation, fetchBetRecord, BET_STATUS } from '@/lib/api'

// FC-9 attestation reportType: a bet that actually filled has a FILLED (1) attestation.
const REPORT_FILLED = 1
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
  totalBalance: bigint
  totalOpenExposure: bigint
  totalDeposited: bigint
  totalWithdrawn: bigint
  totalPnL: bigint
  depositHistory: WalletActivityEvent[]
  withdrawalHistory: WalletActivityEvent[]
  closedBetHistory: Array<WalletActivityEvent & { betAmount: bigint; pnl: bigint }>
}

type SettlementStatus =
  | { kind: 'ready'; payoutPerShare: bigint; claimAmount: bigint }
  | { kind: 'lost' }
  | { kind: 'pending' }

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
    if (!(await betDidFill(nullifierOfBet))) return { kind: 'pending' }

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

async function buildReadyToSettle(receipts: Note[]): Promise<{ ready: ReadyToSettleBet[]; lost: Note[] }> {
  const results = await Promise.all(receipts.map(async (receipt) => ({ receipt, status: await checkSettlementStatus(receipt) })))
  const ready: ReadyToSettleBet[] = []
  const lost: Note[] = []
  for (const { receipt, status } of results) {
    if (status.kind === 'ready') {
      ready.push({ receipt, payoutPerShare: status.payoutPerShare, claimAmount: status.claimAmount } satisfies ReadyToSettleBet)
    } else if (status.kind === 'lost') {
      lost.push(receipt)
    }
  }
  return { ready, lost }
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
  const { ready: readyToSettle, lost: lostBets } = await buildReadyToSettle(openReceipts)
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

  const closedBetHistory = settlementEvents.map((event) => {
    const committed = betEvents.find((bet) => bet.receiptId && bet.receiptId === event.receiptId)?.amount ?? 0n
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
    return { ...event, betAmount, pnl }
  }).concat(
    // A refund returns the user's OWN stake — the unfilled remainder of a partial fill, or the
    // full stake of a failed bet — so it is a CAPITAL RETURN, not a gain/loss: P&L is 0. (The
    // earlier `amount − betAmount` booked a partial-fill refund as a phantom loss, which L3 makes
    // common since downsized market orders now refund the unfilled part; the still-open filled portion
    // settles separately for the real P&L. Exact cost-basis netting of a partial-then-settled bet —
    // crediting the settlement against `spent` rather than the committed stake — is an FC-5 follow-up.)
    refundEvents.map((event) => {
      const betAmount = betEvents.find((bet) => bet.receiptId && bet.receiptId === event.receiptId)?.amount ?? 0n
      return { ...event, betAmount, pnl: 0n }
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
    totalBalance: cashBalance + totalOpenExposure,
    totalOpenExposure,
    totalDeposited,
    totalWithdrawn,
    totalPnL,
    depositHistory,
    withdrawalHistory,
    closedBetHistory,
  }
}

export function usePortfolioState(wallet?: `0x${string}`): {
  state: PortfolioState | null
  loading: boolean
  refresh: () => Promise<void>
} {
  const [state, setState] = useState<PortfolioState | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!wallet) {
      setState(null)
      setLoading(false)
      return
    }

    setLoading(true)
    try {
      setState(await loadPortfolioState(wallet))
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

  return { state, loading, refresh }
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
  const { data: blockNumber } = useBlockNumber({ watch: true, query: { refetchInterval: 3000 } })
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

export function portfolioSummaryRows(state: PortfolioState): Array<[string, string, string]> {
  return [
    ['Total balance', `$${formatUsdc(state.totalBalance)}`, 'Cash plus capital locked in open bets'],
    ['Cash', `$${formatUsdc(state.cashBalance)}`, 'Available right now for a new bet or withdrawal'],
    ['Deposited', `$${formatUsdc(state.totalDeposited)}`, 'Cumulative USDC put into the vault'],
    ['Withdrawn', `$${formatUsdc(state.totalWithdrawn)}`, 'Cumulative USDC sent back to your wallet'],
    ['P&L', `$${formatUsdc(state.totalPnL)}`, 'Settled gains minus losses'],
  ]
}
