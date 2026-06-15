/**
 * GET /api/market-name/:cid — proxies the proof-relay's name-only resolver, which returns a market's
 * human-readable question for ANY conditionId, including closed/ended markets that are filtered out of
 * the bettable catalog. Used by the portfolio to label historical bets (settled / expired / closed)
 * instead of showing a hex id. Returns { name } or 404.
 */
import { NextRequest, NextResponse } from 'next/server'

const RELAY_URL = process.env.PROOF_RELAY_URL ?? 'http://127.0.0.1:3002'
export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ cid: string }> }, // Next 15: params is async
): Promise<NextResponse> {
  const { cid } = await params
  try {
    const res = await fetch(`${RELAY_URL}/market-name/${encodeURIComponent(cid)}`, { cache: 'no-store' })
    if (!res.ok) return NextResponse.json({ name: null }, { status: res.status })
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ name: null }, { status: 503 })
  }
}
