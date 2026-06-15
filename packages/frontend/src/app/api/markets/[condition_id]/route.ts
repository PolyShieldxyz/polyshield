/**
 * GET /api/markets/:conditionId — single market for the detail page (FC-15).
 * Market metadata comes from the proof-relay catalog (ingest-on-miss there); the live CLOB order
 * book + tick size are fetched here (kept in lib/polymarket.ts). No fixture fallback — an honest 404
 * when the market can't be resolved.
 */
import { NextRequest, NextResponse } from 'next/server'
import { fetchBook, fetchTickSize, type LiveMarket } from '@/lib/polymarket'

const RELAY_URL = process.env.PROOF_RELAY_URL ?? 'http://127.0.0.1:3002'
export const dynamic = 'force-dynamic'

const EMPTY_BOOK = {
  bids: [{ price: '0.49', size: '0.00' }],
  asks: [{ price: '0.51', size: '0.00' }],
  hash: `0x${'0'.repeat(64)}`,
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ condition_id: string }> }, // Next 15: params is async
): Promise<NextResponse> {
  const { condition_id } = await params

  let market: LiveMarket | null = null
  try {
    const res = await fetch(`${RELAY_URL}/markets/${encodeURIComponent(condition_id)}`, { cache: 'no-store' })
    if (res.ok) market = ((await res.json()) as { market?: LiveMarket }).market ?? null
  } catch {
    /* fall through to 404 */
  }
  if (!market) {
    return NextResponse.json({ error: 'This market is unavailable.' }, { status: 404 })
  }

  // tickSize feeds L1 ceiling pricing (lib/pricing.ts) so the committed price snaps to the same tick
  // the CLOB executes on; default 0.001 matches the signing layer's budgetedBuyOrder.
  const [book, tickSize] = await Promise.all([
    market.yesTokenId ? fetchBook(market.yesTokenId) : Promise.resolve(null),
    market.yesTokenId ? fetchTickSize(market.yesTokenId) : Promise.resolve(0.001),
  ])
  return NextResponse.json({ market, source: 'live', book: book ?? EMPTY_BOOK, tickSize })
}
