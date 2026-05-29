/**
 * Frontend API client — calls Next.js API proxy routes.
 * The proxy routes forward to the backend services without exposing their ports to the browser.
 *
 * Detailed logging (paths, bodies, nullifiers) is only active in dev mode
 * (NEXT_PUBLIC_DEV_MODE=true) to avoid leaking pseudonymous identifiers in production.
 * Never pass proof witness data (secret, balance, nonce) through these functions.
 */

const devLog = process.env.NEXT_PUBLIC_DEV_MODE === 'true'
  ? (...args: unknown[]) => console.log(...args)
  : (..._args: unknown[]) => undefined

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
  total_credit: string
}

export interface RelayWithdrawalInputs {
  merkle_root: string
  nullifier: string
  withdrawal_amount: string
  recipient_hash: string
  new_commitment: string
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

export interface MerkleProof {
  path: string[]
  pathIndices: number[]
  root: string
  leafIndex: number
}

async function post(path: string, body: unknown): Promise<unknown> {
  devLog(`[polyshield:api] POST ${path}`, body)
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) {
    console.error(`[polyshield:api] POST ${path} failed`, res.status)
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  devLog(`[polyshield:api] POST ${path} →`, data)
  return data
}

async function get(path: string): Promise<unknown> {
  devLog(`[polyshield:api] GET ${path}`)
  const res = await fetch(path)
  const data = await res.json()
  if (!res.ok) {
    console.error(`[polyshield:api] GET ${path} failed`, res.status)
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  devLog(`[polyshield:api] GET ${path} →`, data)
  return data
}

export async function relayBet(
  proof: `0x${string}`,
  inputs: RelayBetInputs,
): Promise<{ txHash: string }> {
  devLog('[polyshield:api] relaying BET_AUTH proof', { nullifier: inputs.nullifier })
  return post('/api/relay/bet', { proof, inputs }) as Promise<{ txHash: string }>
}

export async function relaySettlement(
  proof: `0x${string}`,
  inputs: RelaySettlementInputs,
): Promise<{ txHash: string }> {
  devLog('[polyshield:api] relaying SETTLE_CRED proof', { nullifier: inputs.nullifier })
  return post('/api/relay/settlement', { proof, inputs }) as Promise<{ txHash: string }>
}

export async function relayWithdrawal(
  proof: `0x${string}`,
  inputs: RelayWithdrawalInputs,
  recipientAddress: string,
): Promise<{ txHash: string }> {
  devLog('[polyshield:api] relaying WITHDRAWAL proof', { recipient: recipientAddress })
  return post('/api/relay/withdrawal', { proof, inputs, recipientAddress }) as Promise<{ txHash: string }>
}

export async function relayBetCancel(
  proof: `0x${string}`,
  inputs: RelayBetCancelInputs,
): Promise<{ txHash: string }> {
  devLog('[polyshield:api] relaying BET_CANCEL proof', { nullifier: inputs.nullifier })
  return post('/api/relay/bet-cancel', { proof, inputs }) as Promise<{ txHash: string }>
}

export async function fetchSettlement(marketId: string): Promise<SettlementRecord | null> {
  devLog('[polyshield:api] fetching settlement for', marketId)
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

// Fetch the Merkle inclusion proof for a commitment leaf.
// The proof-relay backend reconstructs the tree from on-chain LeafInserted events.
export async function fetchMerklePath(commitment: `0x${string}`): Promise<MerkleProof> {
  devLog('[polyshield:api] fetching merkle path for', commitment)
  return get(`/api/merkle-path/${commitment}`) as Promise<MerkleProof>
}

// Fetch payout_per_share for a resolved market from Vault.pendingCredit(bytes32,uint8).
// outcome_side: 0 = YES, 1 = NO. Returns 0n if unresolved or if user's side lost.
// Selector: keccak256("pendingCredit(bytes32,uint8)") = 0x64043a2f
export async function fetchPendingCredit(
  vaultAddress: string,
  market_id: `0x${string}`,
  outcome_side: number,
  rpcUrl = process.env.NEXT_PUBLIC_CHAIN_RPC ?? 'http://127.0.0.1:8545',
): Promise<bigint> {
  const data = `0x64043a2f${market_id.slice(2).padStart(64, '0')}${outcome_side.toString(16).padStart(64, '0')}`
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_call',
      params: [{ to: vaultAddress, data }, 'latest'],
    }),
  })
  const json = await res.json() as { result: string }
  return BigInt(json.result ?? '0x0')
}

// Fetch the block.timestamp when a market was resolved (0 if not yet resolved).
// Selector: keccak256("marketResolvedAt(bytes32)") = 0x1acf3695
export async function fetchMarketResolvedAt(
  vaultAddress: string,
  market_id: `0x${string}`,
  rpcUrl = process.env.NEXT_PUBLIC_CHAIN_RPC ?? 'http://127.0.0.1:8545',
): Promise<bigint> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_call',
      params: [{ to: vaultAddress, data: `0x1acf3695${market_id.slice(2).padStart(64, '0')}` }, 'latest'],
    }),
  })
  const json = await res.json() as { result: string }
  return BigInt(json.result ?? '0x0')
}

export async function waitForTransactionConfirmation(
  txHash: `0x${string}`,
  rpcUrl = process.env.NEXT_PUBLIC_CHAIN_RPC ?? 'http://127.0.0.1:8545',
  timeoutMs = 60_000,
  pollMs = 1_500,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      }),
    })

    const json = await res.json() as {
      result?: { status?: string | null } | null
      error?: { message?: string }
    }

    if (json.error?.message) {
      throw new Error(json.error.message)
    }

    if (json.result) {
      if (json.result.status === '0x1') return
      if (json.result.status === '0x0') throw new Error('Transaction reverted on-chain.')
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }

  throw new Error('Timed out waiting for on-chain confirmation.')
}

// Fetch the current Merkle root from the live CommitmentMerkleTree.
// Vault.tree() → tree address → tree.currentRootIndex() → tree.recentRoots(index) → root.
// This must be called fresh before every bet because other deposits shift the root.
export async function fetchCurrentMerkleRoot(
  vaultAddress: string,
  rpcUrl = process.env.NEXT_PUBLIC_CHAIN_RPC ?? 'http://127.0.0.1:8545',
): Promise<`0x${string}`> {
  const call = async (to: string, data: string): Promise<string> => {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    })
    const json = await res.json() as { result: string }
    return json.result
  }

  // 1. vault.tree() → address (last 20 bytes of 32-byte return)
  const treeRaw = await call(vaultAddress, '0xfd54b228')
  const treeAddress = '0x' + treeRaw.slice(-40)

  // 2. tree.currentRootIndex() → uint32
  const indexRaw = await call(treeAddress, '0x90eeb02b')
  const index = parseInt(indexRaw, 16) % 30   // rolling window size = 30

  // 3. tree.recentRoots(uint256 index) → bytes32
  const indexHex = index.toString(16).padStart(64, '0')
  const root = await call(treeAddress, `0xd539857a${indexHex}`) as `0x${string}`

  devLog('[polyshield:api] fetchCurrentMerkleRoot →', root)
  return root
}
