/**
 * Client-side ZK proof generation via @noir-lang/noir_js (ACVM) + @aztec/bb.js (UltraPLONK).
 *
 * All proof generation runs in the browser. Private inputs (secret, balance, nonce)
 * never leave the client. The 63 MB barretenberg WASM is lazy-loaded on first call.
 *
 * Circuits are fetched from /circuits/<name>.json (served from public/).
 * Each backend instance is cached — creating a new UltraPlonkBackend is expensive.
 */

export interface ProofResult {
  /** Raw UltraPLONK proof bytes, hex-encoded with 0x prefix */
  proof: `0x${string}`
  /** Public inputs as 0x-prefixed hex strings, in circuit declaration order */
  publicInputs: string[]
}

// Input types mirror the Noir circuit fn main() signatures exactly.

export interface BetAuthInputs {
  secret: string          // Field (hex or decimal)
  current_balance: bigint // u64
  nonce: bigint           // u64
  merkle_path: string[]   // [Field; 32]
  merkle_path_indices: number[] // [u1; 32]
  share_remainder: bigint // u64
  // public
  merkle_root: string
  nullifier: string
  new_commitment: string
  bet_amount: bigint
  price: bigint
  expected_shares: bigint
  market_id: string
  outcome_side: number    // u8
  position_id: string
}

export interface WithdrawalInputs {
  secret: string
  final_balance: bigint
  nonce: bigint
  merkle_path: string[]
  merkle_path_indices: number[]
  recipient_address: string   // private Field (hex of uint160 address)
  // public
  merkle_root: string
  nullifier: string
  withdrawal_amount: bigint
  recipient_hash: string
}

export interface SettlementInputs {
  secret: string
  balance_before_credit: bigint
  nonce: bigint
  merkle_path: string[]
  merkle_path_indices: number[]
  // public
  merkle_root: string
  nullifier: string
  new_commitment: string
  nullifier_of_bet: string
  market_id: string
  payout_per_share: bigint
  shares_held: bigint
  total_credit: bigint
}

export interface BetCancelInputs {
  secret: string
  current_balance: bigint
  nonce: bigint
  merkle_path: string[]
  merkle_path_indices: number[]
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
  // public
  merkle_root: string
  nullifier: string
  new_commitment: string
  nullifier_of_bet: string
  market_id: string
  bet_amount: bigint
}

// ── Internal cache ────────────────────────────────────────────────────────────

type CircuitJSON = { bytecode: string; abi: object; noir_version: string; hash: string }

const circuitCache = new Map<string, Promise<CircuitJSON>>()
const backendCache = new Map<string, Promise<unknown>>() // UltraPlonkBackend

async function loadCircuit(name: string): Promise<CircuitJSON> {
  if (!circuitCache.has(name)) {
    circuitCache.set(
      name,
      fetch(`/circuits/${name}.json`).then((r) => {
        if (!r.ok) throw new Error(`Failed to load circuit ${name}: HTTP ${r.status}`)
        return r.json() as Promise<CircuitJSON>
      }),
    )
  }
  return circuitCache.get(name)!
}

async function getBackend(name: string): Promise<unknown> {
  if (!backendCache.has(name)) {
    backendCache.set(
      name,
      (async () => {
        const [{ UltraPlonkBackend }, circuit] = await Promise.all([
          // Dynamic import keeps the 63 MB WASM out of the initial bundle
          import('@aztec/bb.js'),
          loadCircuit(name),
        ])
        // threads: 1 — safe in browsers that don't support SharedArrayBuffer
        return new UltraPlonkBackend(circuit.bytecode, { threads: 1 })
      })(),
    )
  }
  return backendCache.get(name)!
}

// ── Shared proof runner ───────────────────────────────────────────────────────

async function prove(circuitName: string, circuitInputs: Record<string, unknown>): Promise<ProofResult> {
  const [{ Noir }, circuit, backend] = await Promise.all([
    import('@noir-lang/noir_js'),
    loadCircuit(circuitName),
    getBackend(circuitName),
  ])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const noir = new Noir(circuit as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { witness } = await noir.execute(circuitInputs as any)

  const { proof, publicInputs } = await (backend as {
    generateProof(w: Uint8Array): Promise<{ proof: Uint8Array; publicInputs: string[] }>
  }).generateProof(witness)

  return {
    proof: `0x${Buffer.from(proof).toString('hex')}`,
    publicInputs,
  }
}

// ── WASM warm-up ─────────────────────────────────────────────────────────────

/**
 * Start downloading and initialising the bb.js WASM in the background.
 *
 * Call this as soon as the user enters the app so the 63 MB bundle is cached
 * before they reach the proof step.  Fire-and-forget: failures are silently
 * swallowed — the user will just pay the init cost when they actually prove.
 *
 * Strategy:
 *   1. Pre-fetch all five circuit JSONs (cheap, ~1.5 MB each)
 *   2. Initialise the bet_auth backend — this triggers the WASM download and
 *      compilation.  All subsequent backends share the same compiled WASM, so
 *      only the first init is expensive.
 */
export function warmUpProver(): void {
  const CIRCUITS = ['bet_auth', 'withdrawal', 'settlement_credit', 'bet_cancel', 'cancel_credit']

  void (async () => {
    try {
      // Pre-fetch all circuit JSONs in parallel (small files, just need to be in browser cache)
      await Promise.all(CIRCUITS.map(loadCircuit))

      // Initialise the first backend — this is what actually downloads + compiles the WASM.
      // The remaining four share the compiled WASM instance and init in the background.
      await getBackend('bet_auth')

      // Kick off the rest without blocking
      for (const name of CIRCUITS.slice(1)) {
        void getBackend(name)
      }
    } catch {
      // Non-fatal: user pays the init cost at prove time instead
    }
  })()
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
    merkle_root:          inputs.merkle_root,
    nullifier:            inputs.nullifier,
    new_commitment:       inputs.new_commitment,
    bet_amount:           inputs.bet_amount.toString(),
    price:                inputs.price.toString(),
    expected_shares:      inputs.expected_shares.toString(),
    market_id:            inputs.market_id,
    outcome_side:         inputs.outcome_side.toString(),
    position_id:          inputs.position_id,
  })
}

export async function generateWithdrawalProof(inputs: WithdrawalInputs): Promise<ProofResult> {
  return prove('withdrawal', {
    secret:               inputs.secret,
    final_balance:        inputs.final_balance.toString(),
    nonce:                inputs.nonce.toString(),
    merkle_path:          inputs.merkle_path,
    merkle_path_indices:  inputs.merkle_path_indices.map(String),
    recipient_address:    inputs.recipient_address,
    merkle_root:          inputs.merkle_root,
    nullifier:            inputs.nullifier,
    withdrawal_amount:    inputs.withdrawal_amount.toString(),
    recipient_hash:       inputs.recipient_hash,
  })
}

export async function generateSettlementProof(inputs: SettlementInputs): Promise<ProofResult> {
  return prove('settlement_credit', {
    secret:                 inputs.secret,
    balance_before_credit:  inputs.balance_before_credit.toString(),
    nonce:                  inputs.nonce.toString(),
    merkle_path:            inputs.merkle_path,
    merkle_path_indices:    inputs.merkle_path_indices.map(String),
    merkle_root:            inputs.merkle_root,
    nullifier:              inputs.nullifier,
    new_commitment:         inputs.new_commitment,
    nullifier_of_bet:       inputs.nullifier_of_bet,
    market_id:              inputs.market_id,
    payout_per_share:       inputs.payout_per_share.toString(),
    shares_held:            inputs.shares_held.toString(),
    total_credit:           inputs.total_credit.toString(),
  })
}

export async function generateBetCancelProof(inputs: BetCancelInputs): Promise<ProofResult> {
  return prove('bet_cancel', {
    secret:               inputs.secret,
    current_balance:      inputs.current_balance.toString(),
    nonce:                inputs.nonce.toString(),
    merkle_path:          inputs.merkle_path,
    merkle_path_indices:  inputs.merkle_path_indices.map(String),
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
    merkle_root:          inputs.merkle_root,
    nullifier:            inputs.nullifier,
    new_commitment:       inputs.new_commitment,
    nullifier_of_bet:     inputs.nullifier_of_bet,
    market_id:            inputs.market_id,
    bet_amount:           inputs.bet_amount.toString(),
  })
}
