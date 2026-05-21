/**
 * Frontend API client — calls Next.js API proxy routes.
 * The proxy routes forward to the backend services without exposing their ports to the browser.
 *
 * All functions log to the browser console for full traceability.
 * Never pass proof witness data (secret, balance, nonce) through these functions.
 */

export interface DevStatus {
  anvil: boolean
  proofRelay: boolean
  indexer: boolean
  mockClob: boolean
  vaultAddress: string | null
  usdcAddress: string | null
  chainId: number | null
  devMode: boolean
}

export interface RelayBetInputs {
  merkle_root: string
  nullifier: string
  new_commitment: string
  bet_amount: string      // uint64 as decimal string
  price: string           // uint64 as decimal string
  expected_shares: string // uint64 as decimal string
  market_id: string
  outcome_side: number
  position_id: string
}

export interface RelaySettlementInputs {
  merkle_root: string
  nullifier: string
  new_commitment: string
  nullifier_of_bet: string
  market_id: string
  payout_per_share: string
  total_credit: string
}

export interface RelayWithdrawalInputs {
  merkle_root: string
  nullifier: string
  withdrawal_amount: string
  recipient_hash: string
}

export interface RelayBetCancelInputs {
  merkle_root: string
  nullifier: string
  new_commitment: string
  nullifier_of_bet: string
}

export interface SettlementRecord {
  conditionId: string
  positionId: string
  payout_per_share: number
  block_number: number
  outcome: number
}

async function post(path: string, body: unknown): Promise<unknown> {
  console.log(`[polyshield:api] POST ${path}`, body)
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) {
    console.error(`[polyshield:api] POST ${path} failed`, res.status, data)
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  console.log(`[polyshield:api] POST ${path} →`, data)
  return data
}

async function get(path: string): Promise<unknown> {
  console.log(`[polyshield:api] GET ${path}`)
  const res = await fetch(path)
  const data = await res.json()
  if (!res.ok) {
    console.error(`[polyshield:api] GET ${path} failed`, res.status, data)
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  console.log(`[polyshield:api] GET ${path} →`, data)
  return data
}

export async function relayBet(
  proof: `0x${string}`,
  inputs: RelayBetInputs,
): Promise<{ txHash: string }> {
  console.log('[polyshield:api] relaying BET_AUTH proof', { nullifier: inputs.nullifier })
  return post('/api/relay/bet', { proof, inputs }) as Promise<{ txHash: string }>
}

export async function relaySettlement(
  proof: `0x${string}`,
  inputs: RelaySettlementInputs,
): Promise<{ txHash: string }> {
  console.log('[polyshield:api] relaying SETTLE_CRED proof', { nullifier: inputs.nullifier })
  return post('/api/relay/settlement', { proof, inputs }) as Promise<{ txHash: string }>
}

export async function relayWithdrawal(
  proof: `0x${string}`,
  inputs: RelayWithdrawalInputs,
  recipientAddress: string,
): Promise<{ txHash: string }> {
  console.log('[polyshield:api] relaying WITHDRAWAL proof', { recipient: recipientAddress })
  return post('/api/relay/withdrawal', { proof, inputs, recipientAddress }) as Promise<{ txHash: string }>
}

export async function relayBetCancel(
  proof: `0x${string}`,
  inputs: RelayBetCancelInputs,
): Promise<{ txHash: string }> {
  console.log('[polyshield:api] relaying BET_CANCEL proof', { nullifier: inputs.nullifier })
  return post('/api/relay/bet-cancel', { proof, inputs }) as Promise<{ txHash: string }>
}

export async function fetchSettlement(marketId: string): Promise<SettlementRecord | null> {
  console.log('[polyshield:api] fetching settlement for', marketId)
  try {
    return await get(`/api/settlement/${encodeURIComponent(marketId)}`) as SettlementRecord
  } catch {
    return null
  }
}

export async function fetchDevStatus(): Promise<DevStatus> {
  try {
    return await get('/api/dev/status') as DevStatus
  } catch {
    return {
      anvil: false, proofRelay: false, indexer: false, mockClob: false,
      vaultAddress: null, usdcAddress: null, chainId: null, devMode: false,
    }
  }
}

// Dev-mode mock proof: 64 zero bytes.
// The Anvil MockVerifier accepts any proof, so this lets flows complete without WASM.
export const MOCK_PROOF = `0x${'00'.repeat(64)}` as `0x${string}`

// Dev-mode merkle root: zero bytes32.
// The Anvil CommitmentMerkleTree starts with a known root; for mock proofs use bytes32(0).
export const MOCK_ROOT = `0x${'00'.repeat(32)}` as `0x${string}`
