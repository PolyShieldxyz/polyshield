/**
 * GET /api/events?limit=N
 * Proxies to the proof-relay's /events — all indexed Vault events (public, anonymous) for the
 * Explorer, served from the backend index so the browser doesn't scan the chain (which fails on
 * a metered RPC's getLogs range cap).
 */

import { NextRequest, NextResponse } from 'next/server'

const RELAY_URL = process.env.PROOF_RELAY_URL ?? 'http://127.0.0.1:3002'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const limit = req.nextUrl.searchParams.get('limit') ?? '2000'
  let relayRes: Response
  try {
    relayRes = await fetch(`${RELAY_URL}/events?limit=${encodeURIComponent(limit)}`, { cache: 'no-store' })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[api/events] proof-relay unreachable: ${msg}`)
    return NextResponse.json({ error: 'Proof relay is not running. Start with: pnpm dev:mock' }, { status: 503 })
  }
  const data = await relayRes.json().catch(() => ({}))
  return NextResponse.json(data, { status: relayRes.status })
}
