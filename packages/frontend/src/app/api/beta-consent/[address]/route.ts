/**
 * GET /api/beta-consent/:address — proxies a "has this wallet acknowledged the current terms?"
 * check to the proof-relay so a returning user isn't re-prompted. See proof-relay betaConsent.ts.
 */
import { NextRequest, NextResponse } from 'next/server'

const RELAY_URL = process.env.PROOF_RELAY_URL ?? 'http://127.0.0.1:3002'
export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
): Promise<NextResponse> {
  const { address } = await params
  try {
    const res = await fetch(`${RELAY_URL}/beta-consent/${encodeURIComponent(address)}`, { cache: 'no-store' })
    return NextResponse.json(await res.json().catch(() => ({ consented: false })), { status: res.status })
  } catch {
    return NextResponse.json({ consented: false }, { status: 503 })
  }
}
