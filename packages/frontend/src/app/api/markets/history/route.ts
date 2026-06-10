import { NextRequest, NextResponse } from 'next/server'
import { fetchPriceHistory } from '@/lib/polymarket'

// Live Polymarket price history for a CLOB token, proxied server-side (the CLOB API does
// not send browser CORS headers). The market detail chart polls this every 10s.
export const revalidate = 10

export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = req.nextUrl.searchParams.get('token') ?? ''
  const range = req.nextUrl.searchParams.get('range') ?? '1D'
  if (!token) return NextResponse.json({ history: [] })
  const history = await fetchPriceHistory(token, range)
  return NextResponse.json({ history })
}
