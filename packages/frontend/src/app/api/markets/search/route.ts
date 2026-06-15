/**
 * GET /api/markets/search?q=&limit= — proxies the proof-relay live search (FC-15).
 * proof-relay matches its catalog first and, on sparse hits, live-searches Polymarket (Gamma
 * public-search) and upserts the results. Returns { markets, wentLive }.
 */
import { NextRequest, NextResponse } from 'next/server'

const RELAY_URL = process.env.PROOF_RELAY_URL ?? 'http://127.0.0.1:3002'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const res = await fetch(`${RELAY_URL}/markets/search${req.nextUrl.search}`, { cache: 'no-store' })
    if (!res.ok) return NextResponse.json({ markets: [], wentLive: false }, { status: res.status })
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ markets: [], wentLive: false }, { status: 503 })
  }
}
