/**
 * GET /api/markets — proxies the proof-relay market CATALOG (FC-15).
 * Passes through offset/limit/sort/category/q. The catalog (proof-relay) is the cache and the
 * single bettable-only source; this route does no Gamma call and no fixture fallback. Returns
 * { markets, total }. On proof-relay outage it returns 503 so the UI shows an honest error.
 */
import { NextRequest, NextResponse } from 'next/server'

const RELAY_URL = process.env.PROOF_RELAY_URL ?? 'http://127.0.0.1:3002'
export const dynamic = 'force-dynamic' // always proxy; freshness is the catalog's job, not ISR

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const res = await fetch(`${RELAY_URL}/markets${req.nextUrl.search}`, { cache: 'no-store' })
    if (!res.ok) return NextResponse.json({ markets: [], total: 0 }, { status: res.status })
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ error: 'Markets are temporarily unavailable. Please retry shortly.' }, { status: 503 })
  }
}
