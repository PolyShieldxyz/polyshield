'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { useBlockNumber, useDisconnect, usePublicClient } from 'wagmi'
import { fetchPendingCredit, fetchMarketResolvedAt, fetchBetStatus, fetchAttestation, BET_STATUS } from '@/lib/api'

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
 * Did this bet actually fill (i.e. does the depositor hold shares)? A FOK fill stays
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
  if (!(await betDidFill(nullifierOfBet))) return { kind: 'pending' }
  const outcomeSide = receipt.side === 'NO' ? 1 : 0
  const payoutPerShare = await fetchPendingCredit(VAULT_ADDRESS, circuitKey, outcomeSide)
  if (payoutPerShare > 0n) {
    return { kind: 'ready', payoutPerShare, claimAmount: receipt.expectedShares * payoutPerShare }
  }
  // payout = 0: unresolved OR user's side lost — check resolvedAt to distinguish
  const resolvedAt = await fetchMarketResolvedAt(VAULT_ADDRESS, circuitKey)
  if (resolvedAt > 0n) return { kind: 'lost' }
  return { kind: 'pending' }
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
    const betAmount = betEvents.find((bet) => bet.receiptId && bet.receiptId === event.receiptId)?.amount ?? 0n
    const pnl = event.amount - betAmount
    return { ...event, betAmount, pnl }
  }).concat(
    refundEvents.map((event) => {
      const betAmount = betEvents.find((bet) => bet.receiptId && bet.receiptId === event.receiptId)?.amount ?? 0n
      const pnl = event.amount - betAmount
      return { ...event, betAmount, pnl }
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

  // Secondary signal: block number going backwards. Cheap and instant on the common case,
  // and the only signal if the genesis fetch fails.
  useEffect(() => {
    if (blockNumber === undefined) return
    const current = Number(blockNumber)
    const last = getLastSeenBlock()

    if (last > 0 && current < last) {
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
