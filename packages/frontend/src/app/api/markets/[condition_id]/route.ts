import { NextRequest, NextResponse } from 'next/server'
import { MARKETS, type MarketEntry } from '@/lib/marketsData'

const HOST = process.env.POLY_API_URL ?? process.env.MOCK_CLOB_URL ?? 'https://clob.polymarket.com'

type LiveMarket = {
  condition_id: string
  question?: string
  description?: string
  active?: boolean
  closed?: boolean
  accepting_orders?: boolean
  end_date_iso?: string | null
  volume?: number
  liquidity?: number
  payout_numerators?: number[] | null
  payout_denominator?: number | null
  tokens?: Array<{ outcome?: string; price?: number; token_id?: string }>
}

type BookResponse = {
  bids?: Array<{ price: string; size: string }>
  asks?: Array<{ price: string; size: string }>
  hash?: string
}

function mergeFixture(base: MarketEntry, live?: LiveMarket | null): MarketEntry {
  if (!live) return base
  const yesToken = live.tokens?.find((token) => (token.outcome ?? '').toLowerCase() === 'yes')
  const yes = typeof yesToken?.price === 'number' ? yesToken.price : base.yes
  return {
    ...base,
    name: live.question ?? base.name,
    desc: live.description ?? base.desc,
    yes,
    vol: live.volume ?? base.vol,
    liq: live.liquidity ?? base.liq,
    resolves: live.end_date_iso ? new Date(live.end_date_iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : base.resolves,
  }
}

async function fetchLive(conditionId: string): Promise<{ market: LiveMarket | null, book: BookResponse | null }> {
  try {
    const marketRes = await fetch(`${HOST}/markets/${conditionId}`, { cache: 'no-store' })
    if (!marketRes.ok) return { market: null, book: null }
    const market = await marketRes.json() as LiveMarket
    const yesTokenId = market.tokens?.find((token) => (token.outcome ?? '').toLowerCase() === 'yes')?.token_id
    let book: BookResponse | null = null
    if (yesTokenId) {
      const bookRes = await fetch(`${HOST}/book?token_id=${encodeURIComponent(yesTokenId)}`, { cache: 'no-store' })
      if (bookRes.ok) book = await bookRes.json() as BookResponse
    }
    return { market, book }
  } catch {
    return { market: null, book: null }
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { condition_id: string } },
): Promise<NextResponse> {
  const base = MARKETS.find((market) =>
    market.conditionId.toLowerCase() === params.condition_id.toLowerCase() ||
    market.id.toLowerCase() === params.condition_id.toLowerCase()
  ) ?? MARKETS[0]
  const { market: live, book } = await fetchLive(params.condition_id)

  return NextResponse.json({
    market: mergeFixture(base, live),
    source: live ? 'live' : 'fixture',
    book: book ?? {
      bids: [{ price: '0.49', size: '10000.00' }],
      asks: [{ price: '0.51', size: '10000.00' }],
      hash: `0x${'0'.repeat(64)}`,
    },
  })
}
