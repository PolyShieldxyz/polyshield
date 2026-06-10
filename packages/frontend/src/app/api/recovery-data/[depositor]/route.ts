/**
 * GET /api/recovery-data/:depositor
 * Proxies to the proof-relay's /recovery-data/:depositor (port 3002), which returns the PUBLIC
 * on-chain events the client needs to rebuild this wallet's notes WITHOUT scanning the chain itself.
 * The secret-based matching happens client-side; this endpoint never sees secrets.
 */

import { NextRequest, NextResponse } from 'next/server'

const RELAY_URL = process.env.PROOF_RELAY_URL ?? 'http://127.0.0.1:3002'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ depositor: string }> }, // Next 15: params is async
): Promise<NextResponse> {
  const { depositor } = await params
  if (!/^0x[0-9a-fA-F]{40}$/.test(depositor)) {
    return NextResponse.json({ error: 'depositor must be a 0x-prefixed 20-byte address' }, { status: 400 })
  }
  let relayRes: Response
  try {
    relayRes = await fetch(`${RELAY_URL}/recovery-data/${depositor}`, { cache: 'no-store' })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[api/recovery-data] proof-relay unreachable: ${msg}`)
    return NextResponse.json(
      { error: 'Proof relay is not running. Start with: pnpm dev:mock' },
      { status: 503 },
    )
  }
  const data = await relayRes.json().catch(() => ({}))
  return NextResponse.json(data, { status: relayRes.status })
}
