/**
 * GET /api/merkle-path/:commitment
 * Proxies Merkle path requests to the proof-relay backend (port 3002).
 * Returns { path: string[], pathIndices: number[], root: string, leafIndex: number }
 */

import { NextRequest, NextResponse } from 'next/server'

const RELAY_URL = process.env.PROOF_RELAY_URL ?? 'http://127.0.0.1:3002'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ commitment: string }> }, // Next 15: params is async
): Promise<NextResponse> {
  const { commitment } = await params
  const target = `${RELAY_URL}/merkle-path/${commitment}`

  let relayRes: Response
  try {
    relayRes = await fetch(target, { cache: 'no-store' })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[api/merkle-path] proof-relay unreachable: ${msg}`)
    return NextResponse.json(
      { error: 'Proof relay is not running. Start with: pnpm dev:mock' },
      { status: 503 },
    )
  }

  const data = await relayRes.json().catch(() => ({}))
  return NextResponse.json(data, { status: relayRes.status })
}
