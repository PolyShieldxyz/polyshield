/**
 * Client-side ZK proof generation via snarkjs (Groth16) + circom circuits.
 *
 * Circuit .wasm files (~2.4 MB each) and .zkey files (~8.7 MB each) are fetched
 * from /circuits/ and /zkeys/ on first call to initProver() and cached in memory.
 * All proof generation runs in the browser — private inputs never leave the client.
 *
 * Call initProver() once at app startup. Use isProverReady() / onProverReady() to
 * gate UI controls on asset availability.
 */

export interface ProofResult {
  /** ABI-encoded Groth16 proof: abi.encode(uint256[2] pA, uint256[2][2] pB, uint256[2] pC) — 256 bytes */
  proof: `0x${string}`
  /** Public signals as 0x-prefixed 32-byte hex strings, in circuit declaration order */
  publicInputs: string[]
}

// Input types mirror the circom circuit signal names exactly.

export interface BetAuthInputs {
  secret: string
  current_balance: bigint
  nonce: bigint
  merkle_path: string[]
  merkle_path_indices: number[]
  share_remainder: bigint
  owner_address: string
  // public
  merkle_root: string
  nullifier: string
  new_commitment: string
  bet_amount: bigint
  price: bigint
  expected_shares: bigint
  market_id: string
  outcome_side: number
  position_id: string
  // FEE: Vault-injected fee (= bet_amount*betFeeBps/10000 + relayGasFeeUSDC). The circuit
  // enforces new_balance = current_balance - bet_amount - fee. Must equal the value the Vault
  // computes from its governance storage, or the proof's new_commitment will not match.
  fee: bigint
}

export interface WithdrawalInputs {
  secret: string
  final_balance: bigint
  nonce: bigint
  merkle_path: string[]
  merkle_path_indices: number[]
  owner_address: string
  recipient_address: string
  // public
  merkle_root: string
  nullifier: string
  withdrawal_amount: bigint
  recipient_hash: string
  new_commitment: string
}

export interface SettlementInputs {
  secret: string
  balance_before_credit: bigint
  nonce: bigint
  /** Nonce of the note that was spent at bet auth time. Private input — allows settling
   *  any open bet regardless of how many subsequent note actions have occurred. */
  bet_nonce: bigint
  merkle_path: string[]
  merkle_path_indices: number[]
  owner_address: string
  // public
  merkle_root: string
  nullifier: string
  new_commitment: string
  nullifier_of_bet: string
  market_id: string
  total_credit: bigint
}

export interface BetCancelInputs {
  secret: string
  current_balance: bigint
  nonce: bigint
  merkle_path: string[]
  merkle_path_indices: number[]
  owner_address: string
  // public
  merkle_root: string
  nullifier: string
  new_commitment: string
  nullifier_of_bet: string
  bet_amount: bigint
}

export interface CancelCreditInputs {
  secret: string
  current_balance: bigint
  nonce: bigint
  merkle_path: string[]
  merkle_path_indices: number[]
  owner_address: string
  // public
  merkle_root: string
  nullifier: string
  new_commitment: string
  nullifier_of_bet: string
  market_id: string
  bet_amount: bigint
}

// FC-4: partial-fill credit. Constraint-identical to BetCancelInputs; refund_amount
// (bet_amount - spent_amount) is Vault-injected on-chain from reportPartialFill.
export interface PartialCreditInputs {
  secret: string
  current_balance: bigint
  nonce: bigint
  merkle_path: string[]
  merkle_path_indices: number[]
  owner_address: string
  // public
  merkle_root: string
  nullifier: string
  new_commitment: string
  nullifier_of_bet: string
  refund_amount: bigint
}

// FC-2: mandatory deposit binding proof. Tiny single-hash circuit (no Merkle path).
export interface DepositInputs {
  secret: string
  // public
  commitment: string
  amount: bigint
  owner_address: string
}

// FC-1: position close credit. Mirrors SettlementInputs; sell_proceeds is
// Vault-injected on-chain from the operator's reportSold.
export interface PositionCloseInputs {
  secret: string
  balance_before_credit: bigint
  nonce: bigint
  /** Nonce of the note spent at bet auth time (private). */
  bet_nonce: bigint
  merkle_path: string[]
  merkle_path_indices: number[]
  owner_address: string
  // public
  merkle_root: string
  nullifier: string
  new_commitment: string
  nullifier_of_bet: string
  sell_proceeds: bigint
}

/** FC-8: consolidate up to 4 same-owner notes into one. Arrays are length-4; inactive
 *  slots have is_active=0 (and nullifier "0"), and their other fields may be dummy zeros. */
export interface ConsolidateInputs {
  secret: string[]               // length 4
  balance: bigint[]              // length 4
  nonce: bigint[]                // length 4
  merkle_path: string[][]        // [4][32]
  merkle_path_indices: number[][] // [4][32]
  is_active: number[]            // length 4 (0 or 1; slot 0 must be 1)
  owner_address: string
  // public
  merkle_root: string
  nullifier: string[]            // length 4 (inactive slots "0")
  new_commitment: string
}

// ── Internals ────────────────────────────────────────────────────────────────

const CIRCUIT_NAMES = ['bet_auth', 'withdrawal', 'settlement_credit', 'bet_cancel', 'cancel_credit', 'deposit', 'position_close', 'partial_credit', 'consolidate'] as const
type CircuitName = typeof CIRCUIT_NAMES[number]

const wasmCache = new Map<CircuitName, Promise<Uint8Array>>()
const zkeyCache = new Map<CircuitName, Promise<Uint8Array>>()

let _isReady = false
const _readyCallbacks: Array<() => void> = []

async function fetchAsset(url: string): Promise<Uint8Array> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    // DEV: `pnpm setup:circuits` overwrites e.g. bet_auth.wasm in place, but the browser may
    // already hold the old file cached as `immutable` (PERF-001 header) and will NOT revalidate
    // it — serving a STALE circuit whose witness/VK no longer match the on-chain verifier
    // (symptom: assertion line numbers off vs source, or proofs failing). `no-store` forces a
    // fresh network fetch, bypassing any existing cache entry. Production keeps the immutable
    // cache (artifacts are fixed per release) for instant repeat loads.
    const cache: RequestCache =
      process.env.NODE_ENV !== 'production' ? 'no-store' : 'default'
    const r = await fetch(url, { signal: controller.signal, cache })
    if (!r.ok) throw new Error(`[prover] Failed to fetch ${url}: HTTP ${r.status}`)
    return new Uint8Array(await r.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }
}

function ensurePreloaded(name: CircuitName): void {
  if (!wasmCache.has(name)) wasmCache.set(name, fetchAsset(`/circuits/${name}.wasm`))
  if (!zkeyCache.has(name)) zkeyCache.set(name, fetchAsset(`/zkeys/${name}.zkey`))
}

// ABI-encode Groth16 proof as 256-byte hex string matching abi.decode in the Solidity adapter.
// G2 coordinate pairs are reversed vs snarkjs ordering (EIP-197 convention).
function encodeProof(proof: import('snarkjs').Groth16Proof): `0x${string}` {
  const words: bigint[] = [
    BigInt(proof.pi_a[0]),
    BigInt(proof.pi_a[1]),
    BigInt(proof.pi_b[0][1]), // G2 coords swapped
    BigInt(proof.pi_b[0][0]),
    BigInt(proof.pi_b[1][1]),
    BigInt(proof.pi_b[1][0]),
    BigInt(proof.pi_c[0]),
    BigInt(proof.pi_c[1]),
  ]
  return `0x${words.map(w => w.toString(16).padStart(64, '0')).join('')}` as `0x${string}`
}

function signalToHex(sig: string): string {
  return `0x${BigInt(sig).toString(16).padStart(64, '0')}`
}

type SnarkjsInputs = Record<string, string | string[] | string[][]>

async function prove(name: CircuitName, inputs: SnarkjsInputs): Promise<ProofResult> {
  ensurePreloaded(name)
  const [snarkjs, wasm, zkey] = await Promise.all([
    // Dynamic import keeps snarkjs out of the SSR bundle
    import('snarkjs'),
    wasmCache.get(name)!,
    zkeyCache.get(name)!,
  ])

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    // snarkjs accepts nested arrays (e.g. consolidate's merkle_path[4][32]) at runtime;
    // its TS signature is narrower, so cast through unknown.
    inputs as unknown as Record<string, string | string[]>,
    { type: 'mem', data: wasm },
    { type: 'mem', data: zkey },
  )

  return {
    proof: encodeProof(proof),
    publicInputs: publicSignals.map(signalToHex),
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

// FINDING: PERF-001 — only the circuits needed for the entry flow are preloaded.
// Eagerly fetching all 8 circuits pulled ~90 MB on app entry; the remaining
// circuits are fetched lazily by ensurePreloaded() the first time prove() needs
// them. Long-lived immutable caching (next.config.js headers) keeps repeat loads
// instant.
const PRELOAD_CIRCUITS: readonly CircuitName[] = ['deposit', 'bet_auth']

/**
 * Fetch the entry-flow circuit .wasm and .zkey files in the background.
 * Call once at app entry. Fires-and-forgets — the user can still prove with any
 * circuit before completion (other assets are fetched on-demand at that point).
 */
export function initProver(): void {
  // Kick off the entry-flow asset fetches in parallel; others load on demand.
  for (const name of PRELOAD_CIRCUITS) ensurePreloaded(name)

  void (async () => {
    try {
      await Promise.all([
        ...PRELOAD_CIRCUITS.map(n => wasmCache.get(n)!),
        ...PRELOAD_CIRCUITS.map(n => zkeyCache.get(n)!),
      ])
      _isReady = true
      _readyCallbacks.splice(0).forEach(cb => cb())
    } catch {
      // Non-fatal: assets will be fetched on-demand when prove() is called
    }
  })()
}

export function isProverReady(): boolean {
  return _isReady
}

export function onProverReady(cb: () => void): void {
  if (_isReady) { cb(); return }
  _readyCallbacks.push(cb)
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function generateBetAuthProof(inputs: BetAuthInputs): Promise<ProofResult> {
  return prove('bet_auth', {
    secret:               inputs.secret,
    current_balance:      inputs.current_balance.toString(),
    nonce:                inputs.nonce.toString(),
    merkle_path:          inputs.merkle_path,
    merkle_path_indices:  inputs.merkle_path_indices.map(String),
    share_remainder:      inputs.share_remainder.toString(),
    owner_address:        inputs.owner_address,
    merkle_root:          inputs.merkle_root,
    nullifier:            inputs.nullifier,
    new_commitment:       inputs.new_commitment,
    bet_amount:           inputs.bet_amount.toString(),
    price:                inputs.price.toString(),
    expected_shares:      inputs.expected_shares.toString(),
    market_id:            inputs.market_id,
    outcome_side:         inputs.outcome_side.toString(),
    position_id:          inputs.position_id,
    fee:                  inputs.fee.toString(),
  })
}

export async function generateWithdrawalProof(inputs: WithdrawalInputs): Promise<ProofResult> {
  return prove('withdrawal', {
    secret:               inputs.secret,
    final_balance:        inputs.final_balance.toString(),
    nonce:                inputs.nonce.toString(),
    merkle_path:          inputs.merkle_path,
    merkle_path_indices:  inputs.merkle_path_indices.map(String),
    owner_address:        inputs.owner_address,
    recipient_address:    inputs.recipient_address,
    merkle_root:          inputs.merkle_root,
    nullifier:            inputs.nullifier,
    withdrawal_amount:    inputs.withdrawal_amount.toString(),
    recipient_hash:       inputs.recipient_hash,
    new_commitment:       inputs.new_commitment,
  })
}

export async function generateSettlementProof(inputs: SettlementInputs): Promise<ProofResult> {
  return prove('settlement_credit', {
    secret:                inputs.secret,
    balance_before_credit: inputs.balance_before_credit.toString(),
    nonce:                 inputs.nonce.toString(),
    bet_nonce:             inputs.bet_nonce.toString(),
    merkle_path:           inputs.merkle_path,
    merkle_path_indices:   inputs.merkle_path_indices.map(String),
    owner_address:         inputs.owner_address,
    merkle_root:           inputs.merkle_root,
    nullifier:             inputs.nullifier,
    new_commitment:        inputs.new_commitment,
    nullifier_of_bet:      inputs.nullifier_of_bet,
    market_id:             inputs.market_id,
    total_credit:          inputs.total_credit.toString(),
  })
}

export async function generateBetCancelProof(inputs: BetCancelInputs): Promise<ProofResult> {
  return prove('bet_cancel', {
    secret:               inputs.secret,
    current_balance:      inputs.current_balance.toString(),
    nonce:                inputs.nonce.toString(),
    merkle_path:          inputs.merkle_path,
    merkle_path_indices:  inputs.merkle_path_indices.map(String),
    owner_address:        inputs.owner_address,
    merkle_root:          inputs.merkle_root,
    nullifier:            inputs.nullifier,
    new_commitment:       inputs.new_commitment,
    nullifier_of_bet:     inputs.nullifier_of_bet,
    bet_amount:           inputs.bet_amount.toString(),
  })
}

export async function generateCancelCreditProof(inputs: CancelCreditInputs): Promise<ProofResult> {
  return prove('cancel_credit', {
    secret:               inputs.secret,
    current_balance:      inputs.current_balance.toString(),
    nonce:                inputs.nonce.toString(),
    merkle_path:          inputs.merkle_path,
    merkle_path_indices:  inputs.merkle_path_indices.map(String),
    owner_address:        inputs.owner_address,
    merkle_root:          inputs.merkle_root,
    nullifier:            inputs.nullifier,
    new_commitment:       inputs.new_commitment,
    nullifier_of_bet:     inputs.nullifier_of_bet,
    market_id:            inputs.market_id,
    bet_amount:           inputs.bet_amount.toString(),
  })
}

export async function generateDepositProof(inputs: DepositInputs): Promise<ProofResult> {
  return prove('deposit', {
    secret:        inputs.secret,
    commitment:    inputs.commitment,
    amount:        inputs.amount.toString(),
    owner_address: inputs.owner_address,
  })
}

export async function generatePositionCloseProof(inputs: PositionCloseInputs): Promise<ProofResult> {
  return prove('position_close', {
    secret:                inputs.secret,
    balance_before_credit: inputs.balance_before_credit.toString(),
    nonce:                 inputs.nonce.toString(),
    bet_nonce:             inputs.bet_nonce.toString(),
    merkle_path:           inputs.merkle_path,
    merkle_path_indices:   inputs.merkle_path_indices.map(String),
    owner_address:         inputs.owner_address,
    merkle_root:           inputs.merkle_root,
    nullifier:             inputs.nullifier,
    new_commitment:        inputs.new_commitment,
    nullifier_of_bet:      inputs.nullifier_of_bet,
    sell_proceeds:         inputs.sell_proceeds.toString(),
  })
}

export async function generatePartialCreditProof(inputs: PartialCreditInputs): Promise<ProofResult> {
  return prove('partial_credit', {
    secret:               inputs.secret,
    current_balance:      inputs.current_balance.toString(),
    nonce:                inputs.nonce.toString(),
    merkle_path:          inputs.merkle_path,
    merkle_path_indices:  inputs.merkle_path_indices.map(String),
    owner_address:        inputs.owner_address,
    merkle_root:          inputs.merkle_root,
    nullifier:            inputs.nullifier,
    new_commitment:       inputs.new_commitment,
    nullifier_of_bet:     inputs.nullifier_of_bet,
    refund_amount:        inputs.refund_amount.toString(),
  })
}

export async function generateConsolidateProof(inputs: ConsolidateInputs): Promise<ProofResult> {
  return prove('consolidate', {
    secret:               inputs.secret,
    balance:              inputs.balance.map(String),
    nonce:                inputs.nonce.map(String),
    merkle_path:          inputs.merkle_path,
    merkle_path_indices:  inputs.merkle_path_indices.map((arr) => arr.map(String)),
    is_active:            inputs.is_active.map(String),
    owner_address:        inputs.owner_address,
    merkle_root:          inputs.merkle_root,
    nullifier:            inputs.nullifier,
    new_commitment:       inputs.new_commitment,
  })
}

// ── Web Worker proof runner ───────────────────────────────────────────────────

import type { ProverWorkerMessage, ProverWorkerResult } from '../workers/prover.worker'

const PROOF_TIMEOUT_MS = 3 * 60 * 1000

/**
 * Run a proof in a dedicated Web Worker to keep the UI responsive.
 * Falls back to main-thread execution if the worker fails to start.
 */
export function generateProofInWorker(message: ProverWorkerMessage): Promise<ProofResult> {
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(new URL('../workers/prover.worker', import.meta.url), { type: 'module' })
    } catch {
      resolve(runProofMainThread(message))
      return
    }

    const timeout = window.setTimeout(() => {
      worker.terminate()
      reject(new Error('Proof generation timed out after 3 minutes'))
    }, PROOF_TIMEOUT_MS)

    worker.onmessage = (event: MessageEvent<ProverWorkerResult>) => {
      clearTimeout(timeout)
      worker.terminate()
      if (event.data.type === 'done') {
        resolve(event.data.result)
      } else {
        reject(new Error(event.data.message))
      }
    }

    worker.onerror = () => {
      clearTimeout(timeout)
      worker.terminate()
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('polyshield:prover-fallback'))
      }
      console.warn('[prover] Worker failed, falling back to main thread')
      runProofMainThread(message).then(resolve, reject)
    }

    worker.postMessage(message)
  })
}

function runProofMainThread(message: ProverWorkerMessage): Promise<ProofResult> {
  switch (message.type) {
    case 'bet_auth':       return generateBetAuthProof(message.inputs)
    case 'withdrawal':     return generateWithdrawalProof(message.inputs)
    case 'settlement':     return generateSettlementProof(message.inputs)
    case 'bet_cancel':     return generateBetCancelProof(message.inputs)
    case 'cancel_credit':  return generateCancelCreditProof(message.inputs)
    case 'deposit':        return generateDepositProof(message.inputs)
    case 'position_close': return generatePositionCloseProof(message.inputs)
    case 'partial_credit': return generatePartialCreditProof(message.inputs)
    case 'consolidate':    return generateConsolidateProof(message.inputs)
  }
}
