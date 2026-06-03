/**
 * POST /api/relay/[action]
 * Proxies proof relay submissions to the proof-relay backend service (port 3002).
 * Keeps backend service URLs server-side. Source IPs are not forwarded.
 *
 * Routes proxied:
 *   POST /api/relay/bet        → proof-relay POST /relay/bet
 *   POST /api/relay/settlement → proof-relay POST /relay/settlement
 *   POST /api/relay/withdrawal → proof-relay POST /relay/withdrawal
 *   POST /api/relay/bet-cancel → proof-relay POST /relay/bet-cancel
 *   POST /api/relay/na-cancel  → proof-relay POST /relay/na-cancel
 */

import { NextRequest, NextResponse } from 'next/server'

const RELAY_URL = process.env.PROOF_RELAY_URL ?? 'http://127.0.0.1:3002'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string[] }> }, // Next 15: params is async
): Promise<NextResponse> {
  const { slug } = await params
  const action = slug.join('/')
  const target = `${RELAY_URL}/relay/${action}`

  console.log(`[api/relay] → POST ${target}`)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  let relayRes: Response
  try {
    relayRes = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store', // Next 15: don't cache user-request forwards
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[api/relay] proof-relay unreachable at ${target}: ${msg}`)
    return NextResponse.json(
      { error: 'Proof relay is not running. Start with: pnpm dev:mock' },
      { status: 503 },
    )
  }

  const data = await relayRes.json().catch(() => ({}))
  console.log(`[api/relay] ← ${relayRes.status}`, JSON.stringify(data))

  return NextResponse.json(data, { status: relayRes.status })
}
