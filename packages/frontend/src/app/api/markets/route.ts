import { NextRequest, NextResponse } from 'next/server'
import { MARKETS, type MarketEntry } from '@/lib/marketsData'

const HOST = process.env.POLY_API_URL ?? process.env.MOCK_CLOB_URL ?? 'https://clob.polymarket.com'

type LiveMarket = {
  condition_id: string
  question?: string
  active?: boolean
  closed?: boolean
  accepting_orders?: boolean
  end_date_iso?: string | null
  volume?: number
  liquidity?: number
  tokens?: Array<{ outcome?: string; price?: number; token_id?: string }>
}

function mergeFixture(base: MarketEntry, live?: LiveMarket | null): MarketEntry {
  if (!live) return base
  const yesToken = live.tokens?.find((token) => (token.outcome ?? '').toLowerCase() === 'yes')
  const yes = typeof yesToken?.price === 'number' ? yesToken.price : base.yes
  return {
    ...base,
    name: live.question ?? base.name,
    yes,
    vol: live.volume ?? base.vol,
    liq: live.liquidity ?? base.liq,
    resolves: live.end_date_iso ? new Date(live.end_date_iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : base.resolves,
  }
}

async function fetchLive(conditionId: string): Promise<LiveMarket | null> {
  try {
    const res = await fetch(`${HOST}/markets/${conditionId}`, { cache: 'no-store' })
    if (!res.ok) return null
    return await res.json() as LiveMarket
  } catch {
    return null
  }
}

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const merged = await Promise.all(
    MARKETS.map(async (market) => {
      const live = await fetchLive(market.conditionId)
      return mergeFixture(market, live)
    }),
  )

  return NextResponse.json(merged)
}
