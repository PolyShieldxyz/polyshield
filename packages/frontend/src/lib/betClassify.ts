/**
 * Shared classification of a BET_RECEIPT note into its display state, from the on-chain BetStatus +
 * the operator's off-chain fill attestation. Extracted from the portfolio so the market-page "Your
 * Position" panel classifies a receipt EXACTLY the same way (one rulebook, no surface drift).
 *
 * Inputs are looked up per-receipt by the caller (status via fetchBetStatus, outcome/fill via
 * fetchAttestation). `ready` = the market has resolved and the position is creditable (settlement).
 */

import { BET_STATUS } from './api'

const REPORT_FILLED = 1
const REPORT_FAILED = 2
const REPORT_PARTIAL = 3

export interface ReceiptClassInputs {
  ready?: boolean // market resolved → settle path
  status: number // on-chain BetStatus (-1 if unknown)
  outcome: number // operator attestation reportType (0 = none yet)
  betAmount: bigint
  fill?: { filled: bigint; spent: bigint } // from a PARTIAL attestation
}

export interface ReceiptClass {
  ready: boolean
  isPartial: boolean
  isFailed: boolean
  isFilled: boolean
  isResting: boolean // a live limit order on the book
  isPending: boolean // submitted, no terminal/resting signal yet
  isPosition: boolean // holds (or will hold) shares: ready || filled || partial
}

export function classifyReceipt(i: ReceiptClassInputs): ReceiptClass {
  const ready = !!i.ready
  const onchainFilled = i.status === BET_STATUS.FILLED
  const isPartialAttest = i.outcome === REPORT_PARTIAL && !onchainFilled
  // A "fee-only" partial (the taker fee ate a sliver of the stake) is effectively a full fill — show
  // it as FILLED, not as a refundable partial. A genuine partial has real unfilled stake left.
  const feeOnlyFill = isPartialAttest && !!i.fill && i.betAmount > 0n && i.fill.spent >= i.betAmount
  const isPartial = isPartialAttest && !feeOnlyFill
  const isFailed = i.outcome === REPORT_FAILED
  const isFilled = i.outcome === REPORT_FILLED || onchainFilled || feeOnlyFill
  const isResting = i.status === BET_STATUS.RESTING
  const isPosition = ready || isFilled || isPartial
  const isPending = !isPosition && !isFailed && !isResting
  return { ready, isPartial, isFailed, isFilled, isResting, isPending, isPosition }
}
