/**
 * GET /api/settlement/[market_id]
 * Proxies to the indexer service (port 3003) to fetch settlement data.
 */

import { NextRequest, NextResponse } from 'next/server'

const INDEXER_URL = process.env.INDEXER_URL ?? 'http://127.0.0.1:3003'

export async function GET(
  _req: NextRequest,
  { params }: { params: { market_id: string } },
): Promise<NextResponse> {
  const { market_id } = params
  const target = `${INDEXER_URL}/settlement/${encodeURIComponent(market_id)}`

  console.log(`[api/settlement] → GET ${target}`)

  let res: Response
  try {
    res = await fetch(target, { cache: 'no-store' })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[api/settlement] indexer unreachable: ${msg}`)
    return NextResponse.json(
      { error: 'Indexer service is not running. Start with: pnpm dev:mock' },
      { status: 503 },
    )
  }

  const data = await res.json().catch(() => ({}))
  console.log(`[api/settlement] ← ${res.status}`, JSON.stringify(data))

  return NextResponse.json(data, { status: res.status })
}
