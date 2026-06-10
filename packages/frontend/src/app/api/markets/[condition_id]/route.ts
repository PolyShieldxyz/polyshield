import { NextRequest, NextResponse } from 'next/server'
import { fetchLiveMarket, fetchBook, fetchTickSize } from '@/lib/polymarket'
import { MARKETS } from '@/lib/marketsData'

const EMPTY_BOOK = {
  bids: [{ price: '0.49', size: '0.00' }],
  asks: [{ price: '0.51', size: '0.00' }],
  hash: `0x${'0'.repeat(64)}`,
}

// Single live Polymarket market by conditionId + its CLOB order book. Falls back to a
// fixture only if Gamma can't resolve the conditionId.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ condition_id: string }> }, // Next 15: params is async
): Promise<NextResponse> {
  const { condition_id } = await params

  const live = await fetchLiveMarket(condition_id)
  if (live) {
    // tickSize feeds L1 ceiling pricing (lib/pricing.ts) so the committed price snaps to the same
    // tick the CLOB executes on. Default 0.001 matches the signing layer's budgetedBuyOrder.
    const [book, tickSize] = await Promise.all([
      live.yesTokenId ? fetchBook(live.yesTokenId) : Promise.resolve(null),
      live.yesTokenId ? fetchTickSize(live.yesTokenId) : Promise.resolve(0.001),
    ])
    return NextResponse.json({ market: live, source: 'live', book: book ?? EMPTY_BOOK, tickSize })
  }

  // Degraded fallback (Gamma unreachable / non-binary conditionId).
  const base =
    MARKETS.find(
      (m) =>
        m.conditionId.toLowerCase() === condition_id.toLowerCase() ||
        m.id.toLowerCase() === condition_id.toLowerCase(),
    ) ?? MARKETS[0]
  return NextResponse.json({ market: base, source: 'fixture', book: EMPTY_BOOK, tickSize: 0.001 })
}
