/**
 * POST /api/beta-consent — proxies a signed beta terms-acknowledgement to the proof-relay.
 * Body: { address, signature }. The relay verifies the signature against the canonical disclaimer
 * and stores (address, signature, version, timestamp). See proof-relay betaConsent.ts.
 */
import { NextRequest, NextResponse } from 'next/server'

const RELAY_URL = process.env.PROOF_RELAY_URL ?? 'http://127.0.0.1:3002'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  }
  try {
    const res = await fetch(`${RELAY_URL}/beta-consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    })
    return NextResponse.json(await res.json().catch(() => ({})), { status: res.status })
  } catch {
    return NextResponse.json({ error: 'relay unreachable' }, { status: 503 })
  }
}
