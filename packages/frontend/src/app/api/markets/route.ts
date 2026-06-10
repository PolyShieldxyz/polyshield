import { NextResponse } from 'next/server'
import { fetchLiveMarkets } from '@/lib/polymarket'
import { MARKETS } from '@/lib/marketsData'

// Live Polymarket market list (binary YES/NO, top by 24h volume). Falls back to the
// local fixtures only if the Gamma API is unreachable, so the page is never empty.
export const revalidate = 30

export async function GET(): Promise<NextResponse> {
  const live = await fetchLiveMarkets(48)
  if (live.length > 0) return NextResponse.json(live)
  return NextResponse.json(MARKETS) // degraded fallback
}
