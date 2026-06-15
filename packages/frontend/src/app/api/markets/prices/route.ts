/**
 * GET /api/markets/prices?ids=tokenId,tokenId — proxies the proof-relay odds overlay (FC-15).
 * Returns { prices: { tokenId: midpoint } } from the CLOB for the visible markets' YES tokens.
 * Decoupled from the (cached) catalog so odds can refresh fast without reordering the list.
 */
import { NextRequest, NextResponse } from 'next/server'

const RELAY_URL = process.env.PROOF_RELAY_URL ?? 'http://127.0.0.1:3002'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const res = await fetch(`${RELAY_URL}/markets/prices${req.nextUrl.search}`, { cache: 'no-store' })
    if (!res.ok) return NextResponse.json({ prices: {} }, { status: res.status })
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ prices: {} }, { status: 503 })
  }
}
