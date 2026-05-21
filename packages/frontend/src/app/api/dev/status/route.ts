/**
 * GET /api/dev/status
 * Checks reachability of all local dev services and returns their status.
 * Used by the DevStatusBar component to show which layers are connected.
 */

import { NextResponse } from 'next/server'

const ANVIL_URL    = process.env.NEXT_PUBLIC_CHAIN_RPC  ?? 'http://127.0.0.1:8545'
const RELAY_URL    = process.env.PROOF_RELAY_URL         ?? 'http://127.0.0.1:3002'
const INDEXER_URL  = process.env.INDEXER_URL             ?? 'http://127.0.0.1:3003'
const CLOB_URL     = process.env.MOCK_CLOB_URL           ?? 'http://127.0.0.1:3001'

const VAULT_ADDRESS = process.env.NEXT_PUBLIC_VAULT_ADDRESS ?? null
const USDC_ADDRESS  = process.env.NEXT_PUBLIC_USDC_ADDRESS  ?? null
const CHAIN_ID      = process.env.NEXT_PUBLIC_CHAIN_ID ? Number(process.env.NEXT_PUBLIC_CHAIN_ID) : null
const DEV_MODE      = process.env.NEXT_PUBLIC_DEV_MODE === 'true'

async function ping(url: string, jsonRpc = false): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: jsonRpc ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: jsonRpc
        ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] })
        : undefined,
      signal: AbortSignal.timeout(2000),
    })
    return res.ok || res.status < 500
  } catch {
    return false
  }
}

export async function GET(): Promise<NextResponse> {
  console.log('[api/dev/status] checking all services')

  const [anvil, proofRelay, indexer, mockClob] = await Promise.all([
    ping(ANVIL_URL, true),
    ping(`${RELAY_URL}/health`),
    ping(`${INDEXER_URL}/health`),
    ping(`${CLOB_URL}/health`),
  ])

  const status = { anvil, proofRelay, indexer, mockClob, vaultAddress: VAULT_ADDRESS, usdcAddress: USDC_ADDRESS, chainId: CHAIN_ID, devMode: DEV_MODE }
  console.log('[api/dev/status] →', status)

  return NextResponse.json(status)
}
