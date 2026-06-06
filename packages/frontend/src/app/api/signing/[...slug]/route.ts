/**
 * POST /api/signing/[action]
 * Proxies requests to the signing-layer auto-settlement HTTP server (port 3004).
 * Keeps backend service URLs server-side. Source IPs are not forwarded.
 *
 * Routes proxied:
 *   POST /api/signing/close-request    → signing-layer POST /close-request   (FC-1)
 *   POST /api/signing/claim-permission → signing-layer POST /claim-permission
 */

import { NextRequest, NextResponse } from 'next/server'

const SIGNING_URL = process.env.SIGNING_LAYER_URL ?? 'http://127.0.0.1:3004'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string[] }> }, // Next 15: params is async
): Promise<NextResponse> {
  const { slug } = await params
  const action = slug.join('/')
  const target = `${SIGNING_URL}/${action}`

  console.log(`[api/signing] → POST ${target}`)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  // The signing-layer's mutating routes (limit-order, close-request, claim-permission)
  // are gated by operatorAuth (Bearer OPERATOR_API_TOKEN). These are user-initiated
  // requests TO the operator, so this trusted server-side proxy injects the token from
  // its own env. It is read server-side only (never NEXT_PUBLIC_), so the browser never
  // sees it; the signing layer keeps operatorAuth as defense-in-depth.
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const operatorToken = process.env.OPERATOR_API_TOKEN
  if (operatorToken) headers['Authorization'] = `Bearer ${operatorToken}`

  let upstream: Response
  try {
    upstream = await fetch(target, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      cache: 'no-store', // Next 15: don't cache user-request forwards
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[api/signing] signing layer unreachable at ${target}: ${msg}`)
    return NextResponse.json(
      { error: 'Signing layer is not running. Start with: pnpm dev:mock' },
      { status: 503 },
    )
  }

  const data = await upstream.json().catch(() => ({}))
  console.log(`[api/signing] ← ${upstream.status}`, JSON.stringify(data))

  return NextResponse.json(data, { status: upstream.status })
}

// GET /api/signing/attestation/:nullifier (FC-9) — proxies the operator's public
// attestation read endpoint. The nullifier is already public on-chain; no body.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string[] }> },
): Promise<NextResponse> {
  const { slug } = await params
  const action = slug.join('/')
  const target = `${SIGNING_URL}/${action}`

  console.log(`[api/signing] → GET ${target}`)

  let upstream: Response
  try {
    upstream = await fetch(target, { method: 'GET', cache: 'no-store' })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[api/signing] signing layer unreachable at ${target}: ${msg}`)
    return NextResponse.json(
      { error: 'Signing layer is not running. Start with: pnpm dev:mock' },
      { status: 503 },
    )
  }

  const data = await upstream.json().catch(() => ({}))
  console.log(`[api/signing] ← ${upstream.status}`, JSON.stringify(data))
  return NextResponse.json(data, { status: upstream.status })
}
