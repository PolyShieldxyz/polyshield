/**
 * POST /api/analytics — proxies anonymous, aggregate engagement events to the proof-relay (FC-15).
 * Body: { events: [{ scope, key }] }. NO wallet/IP/id is sent or stored (see proof-relay analytics.ts).
 * Fire-and-forget from the client; failures are swallowed (never block the UI).
 */
import { NextRequest, NextResponse } from 'next/server'

const RELAY_URL = process.env.PROOF_RELAY_URL ?? 'http://127.0.0.1:3002'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 })
  }
  try {
    const res = await fetch(`${RELAY_URL}/analytics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    })
    return NextResponse.json(await res.json().catch(() => ({ ok: true })), { status: res.status })
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 })
  }
}
