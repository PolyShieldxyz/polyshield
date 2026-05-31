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

// FC-1: position close credit proof inputs (sell_proceeds is Vault-injected).
export interface RelayCloseInputs {
  merkle_root: string
  nullifier: string
  new_commitment: string
  nullifier_of_bet: string
}

// FC-4: partial-fill credit proof inputs (refund_amount is Vault-injected).
export interface RelayPartialCreditInputs {
  merkle_root: string
  nullifier: string
  new_commitment: string
  nullifier_of_bet: string
}

// BetStatus enum (Vault.sol): ACTIVE=0, FILLED=1, FAILED=2, CREDITED=3,
// CANCELLED_CREDITED=4, CLOSING=5, CLOSED_CREDITED=6, PARTIAL_FILLED=7, RESTING=8.
export const BET_STATUS = {
  ACTIVE: 0,
  FILLED: 1,
  FAILED: 2,
  CREDITED: 3,
  CANCELLED_CREDITED: 4,
  CLOSING: 5,
  CLOSED_CREDITED: 6,
  PARTIAL_FILLED: 7,
  RESTING: 8,
} as const

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

// FC-1: relay a position-close credit proof to the Vault (via proof-relay).
export async function relayClose(
  proof: `0x${string}`,
  inputs: RelayCloseInputs,
): Promise<{ txHash: string }> {
  devLog('[polyshield:api] relaying POSITION_CLOSE proof', { nullifier: inputs.nullifier })
  return post('/api/relay/close', { proof, inputs }) as Promise<{ txHash: string }>
}

// FC-4: relay a partial-fill credit proof to the Vault (via proof-relay). The Vault
// injects refund_amount = bet_amount - spent_amount from the operator's reportPartialFill.
export async function relayPartialCredit(
  proof: `0x${string}`,
  inputs: RelayPartialCreditInputs,
): Promise<{ txHash: string }> {
  devLog('[polyshield:api] relaying PARTIAL_CREDIT proof', { nullifier: inputs.nullifier })
  return post('/api/relay/partial-credit', { proof, inputs }) as Promise<{ txHash: string }>
}

// FC-4: register a limit-order intent with the signing layer right after relaying
// authorizeBet for an advanced-mode (limit) bet. The event listener then submits a
// resting GTC/GTD order instead of the default FOK. expiration is the GTD effective
// lifetime in seconds (ignored for GTC).
export async function requestLimitOrder(req: {
  nullifier_of_bet: string
  order_type: 'GTC' | 'GTD'
  expiration?: number
}): Promise<{ ok: boolean }> {
  devLog('[polyshield:api] registering limit-order intent', { nullifier_of_bet: req.nullifier_of_bet, order_type: req.order_type })
  return post('/api/signing/limit-order', req) as Promise<{ ok: boolean }>
}

// FC-4: read the partial-fill fields of a bet record from the Vault. Returns the
// on-chain bet_amount and spent_amount (so the frontend can compute the exact
// refund_amount = bet_amount - spent_amount that the Vault will inject) plus
// filled_shares for display. betRecords tuple fields (32 bytes each):
// [0]market_id [1]condition_id [2]position_id [3]expected_shares [4]bet_amount
// [5]outcome_side [6]status [7]sell_proceeds [8]sold_shares [9]filled_shares [10]spent_amount
export async function fetchPartialFill(
  vaultAddress: string,
  nullifier_of_bet: `0x${string}`,
  rpcUrl = process.env.NEXT_PUBLIC_CHAIN_RPC ?? 'http://127.0.0.1:8545',
): Promise<{ status: number; betAmount: bigint; spentAmount: bigint; filledShares: bigint }> {
  const data = `0x3e2ccd6c${nullifier_of_bet.slice(2).padStart(64, '0')}`
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: vaultAddress, data }, 'latest'] }),
  })
  const json = await res.json() as { result?: string }
  const raw = json.result ?? '0x'
  const word = (i: number): bigint => {
    const slice = raw.slice(2 + 64 * i, 2 + 64 * (i + 1))
    return slice.length === 64 ? BigInt('0x' + slice) : 0n
  }
  if (raw.length < 2 + 64 * 11) return { status: -1, betAmount: 0n, spentAmount: 0n, filledShares: 0n }
  return {
    status: Number(word(6)),
    betAmount: word(4),
    spentAmount: word(10),
    filledShares: word(9),
  }
}

// FC-1: ask the signing layer to submit a FOK SELL for a pre-settlement close.
// sold_shares and limit_price are 1e6-scaled decimal strings. The operator reports
// the fill via reportSold (status → CLOSING); the caller then polls the bet status
// and generates the closePosition proof.
export async function requestClose(req: {
  nullifier_of_bet: string
  position_id: string
  sold_shares: string
  limit_price: string
}): Promise<{ ok: boolean }> {
  devLog('[polyshield:api] requesting position close (FOK SELL)', { nullifier_of_bet: req.nullifier_of_bet })
  return post('/api/signing/close-request', req) as Promise<{ ok: boolean }>
}

// FC-1: read a bet record's status from the Vault to detect the CLOSING transition.
// betRecords(bytes32) returns a 9-field tuple; status (BetStatus enum) is field index 6.
// Selector: keccak256("betRecords(bytes32)") = 0x... (computed below from the getter).
export async function fetchBetStatus(
  vaultAddress: string,
  nullifier_of_bet: `0x${string}`,
  rpcUrl = process.env.NEXT_PUBLIC_CHAIN_RPC ?? 'http://127.0.0.1:8545',
): Promise<number> {
  // betRecords getter selector = first 4 bytes of keccak256("betRecords(bytes32)") = 0x3e2ccd6c
  const data = `0x3e2ccd6c${nullifier_of_bet.slice(2).padStart(64, '0')}`
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: vaultAddress, data }, 'latest'] }),
  })
  const json = await res.json() as { result?: string }
  const raw = json.result ?? '0x'
  if (raw.length < 2 + 64 * 7) return -1
  // Tuple fields are 32 bytes each: [market_id, condition_id, position_id, expected_shares,
  // bet_amount, outcome_side, status, sell_proceeds, sold_shares]. status is index 6.
  const statusWord = raw.slice(2 + 64 * 6, 2 + 64 * 7)
  return parseInt(statusWord, 16)
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
