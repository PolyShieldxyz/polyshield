/**
 * Submit a full MARKET (FAK) SELL to close a position — extracted from ClosePositionModal.run (phase 1)
 * so the Settle-&-Withdraw orchestration (Option D) can fire closes without modal context. This only
 * SUBMITS the sell and records the in-flight marker; the proceeds are credited later by finalizeClose
 * once the operator signs the SOLD attestation (the orchestration polls it). Advances no note here.
 *
 * Idempotent: skips if a close marker already exists or the bet is already CLOSING/CLOSED_CREDITED.
 */

import { BET_STATUS, fetchBetRecord, fetchBetStatus, requestClose } from './api'
import { getCloseMarker, markCloseSubmitted } from './closeMarker'
import { type Note } from './notes'

export async function submitMarketClose(
  address: `0x${string}`,
  receipt: Note,
  vaultAddress: string,
): Promise<{ submitted: boolean; reason?: 'no-position-id' | 'no-shares' | 'already-closing' }> {
  const nullifierOfBet = (receipt.nullifier_of_bet ?? receipt.nullifier) as `0x${string}`
  const positionId = receipt.position_id
  if (!positionId) return { submitted: false, reason: 'no-position-id' }

  // Idempotency: a close already in flight (marker) or terminal on-chain → don't resubmit.
  if (getCloseMarker(address, nullifierOfBet)) return { submitted: false, reason: 'already-closing' }
  const status = await fetchBetStatus(vaultAddress, nullifierOfBet)
  if (status === BET_STATUS.CLOSING || status === BET_STATUS.CLOSED_CREDITED) {
    return { submitted: false, reason: 'already-closing' }
  }

  // Size from the authoritative on-chain expected_shares (the Vault requires the SOLD attestation's
  // sold_shares == expected_shares exactly). limit_price = 1 is the permissive floor; the signing layer
  // prices the market SELL at the live best bid, so it crosses any book (including sub-1¢ markets).
  const rec = await fetchBetRecord(vaultAddress, nullifierOfBet)
  if (rec.expectedShares <= 0n) return { submitted: false, reason: 'no-shares' }

  await requestClose({
    nullifier_of_bet: nullifierOfBet,
    position_id: positionId,
    sold_shares: rec.expectedShares.toString(),
    limit_price: '1',
    order_type: 'FAK',
  })
  markCloseSubmitted(address, {
    nullifierOfBet,
    depositIndex: receipt.depositIndex,
    orderKind: 'MARKET',
    priceCents: 0,
    expiration: 0,
    submittedAt: Date.now(),
  })
  return { submitted: true }
}
