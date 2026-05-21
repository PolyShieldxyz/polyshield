/**
 * Client-side note management.
 *
 * A "note" is the private state a depositor holds: (secret, balance, nonce).
 * Commitment = Poseidon3(secret, balance, nonce)  — matches Noir's bn254::hash_3
 * Nullifier  = Poseidon2(secret, nonce)           — matches Noir's bn254::hash_2
 *
 * Both functions use poseidon-lite (verified against Noir's Prover.toml test vectors).
 * Notes are stored in localStorage under key "polyshield:notes".
 * NEVER send note preimages (secret, balance, nonce) to any server.
 */

import { poseidon2, poseidon3 } from 'poseidon-lite'

export type NoteKind = 'DEPOSIT' | 'BET_OUTPUT' | 'SETTLE_CREDIT' | 'CANCEL_CREDIT'

export interface Note {
  id: string           // same as commitment (hex)
  kind: NoteKind
  secret: `0x${string}`
  balance: bigint      // in USDC micro-units (6 decimals)
  nonce: bigint
  commitment: `0x${string}`
  nullifier: `0x${string}`
  spent: boolean
  createdAt: number    // unix ms
  txHash?: string
  marketId?: string
  expectedShares?: bigint  // shares held after a bet, needed for settlement credit
}

const STORAGE_KEY = 'polyshield:notes'

// BN254 scalar field prime — secrets and commitments must be < this value
const BN254_P = 0x30644e72e131a029b85045b68181585d2833e84879b9709142e0f853d0d3883fn

function loadAll(): Note[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as Array<Record<string, unknown>>
    return arr.map((n) => ({
      ...n,
      balance: BigInt(n.balance as string),
      nonce: BigInt(n.nonce as string),
      ...(n.expectedShares != null ? { expectedShares: BigInt(n.expectedShares as string) } : {}),
    })) as Note[]
  } catch {
    return []
  }
}

function saveAll(notes: Note[]): void {
  if (typeof window === 'undefined') return
  const serialized = notes.map((n) => ({
    ...n,
    balance: n.balance.toString(),
    nonce: n.nonce.toString(),
    ...(n.expectedShares != null ? { expectedShares: n.expectedShares.toString() } : {}),
  }))
  localStorage.setItem(STORAGE_KEY, JSON.stringify(serialized))
}

export function getNotes(): Note[] {
  return loadAll()
}

export function getSpendableNotes(): Note[] {
  return loadAll().filter((n) => !n.spent)
}

function hexToBigInt(hex: `0x${string}`): bigint {
  return BigInt(hex)
}

function bigIntToField(n: bigint): string {
  return `0x${n.toString(16).padStart(64, '0')}`
}

export function computeCommitment(
  secret: `0x${string}`,
  balance: bigint,
  nonce: bigint,
): `0x${string}` {
  const s = hexToBigInt(secret)
  const hash = poseidon3([s, balance, nonce])
  return bigIntToField(hash) as `0x${string}`
}

export function computeNullifier(
  secret: `0x${string}`,
  nonce: bigint,
): `0x${string}` {
  const s = hexToBigInt(secret)
  const hash = poseidon2([s, nonce])
  return bigIntToField(hash) as `0x${string}`
}

// Recipient hash for withdrawal: Poseidon2(recipient_address_as_field, 0)
// Matches Noir circuit: bn254::hash_2([recipient_address, 0])
export function computeRecipientHash(recipientAddress: `0x${string}`): `0x${string}` {
  const addrBigInt = BigInt(recipientAddress)
  const hash = poseidon2([addrBigInt, 0n])
  return bigIntToField(hash) as `0x${string}`
}

// Market/position IDs must be valid BN254 field elements (< p).
// We keccak256-hash the label then reduce mod p — keeps it deterministic.
export function marketToField(label: string): `0x${string}` {
  // Use the TextEncoder to get a consistent byte representation
  const enc = new TextEncoder().encode(label)
  // Simple deterministic field derivation: hash bytes via SubtleCrypto isn't sync,
  // so we use a manual djb2-style large-bigint accumulation reduced mod p.
  // In a real deployment this would use a fixed on-chain condition ID.
  let h = 5381n
  for (const b of enc) {
    h = ((h << 5n) + h + BigInt(b)) & ((1n << 256n) - 1n)
  }
  return bigIntToField(h % BN254_P) as `0x${string}`
}

export function positionToField(marketId: string, side: string): `0x${string}` {
  return marketToField(marketId + ':' + side)
}

export function generateSecret(): `0x${string}` {
  // Sample rejection-free: keep retrying until random bytes < BN254 prime.
  // Expected retries: ~1.08 (p is just slightly less than 2^254).
  while (true) {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    const val = BigInt('0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''))
    if (val > 0n && val < BN254_P) {
      return `0x${val.toString(16).padStart(64, '0')}` as `0x${string}`
    }
  }
}

export function createDepositNote(amountUsdc: bigint, txHash?: string): Note {
  const secret = generateSecret()
  const nonce = 0n
  const commitment = computeCommitment(secret, amountUsdc, nonce)
  const nullifier = computeNullifier(secret, nonce)

  const note: Note = {
    id: commitment,
    kind: 'DEPOSIT',
    secret,
    balance: amountUsdc,
    nonce,
    commitment,
    nullifier,
    spent: false,
    createdAt: Date.now(),
    txHash,
  }

  const notes = loadAll()
  notes.push(note)
  saveAll(notes)

  console.log('[polyshield:notes] created deposit note', {
    commitment,
    balance: amountUsdc.toString(),
    nullifier,
    txHash,
  })

  return note
}

export function markNoteSpent(commitment: `0x${string}`): void {
  const notes = loadAll()
  const idx = notes.findIndex((n) => n.commitment === commitment)
  if (idx >= 0) {
    notes[idx].spent = true
    saveAll(notes)
    console.log('[polyshield:notes] marked spent:', commitment)
  }
}

export function addNote(note: Note): void {
  const notes = loadAll()
  notes.push(note)
  saveAll(notes)
  console.log('[polyshield:notes] added note', { id: note.id, kind: note.kind })
}

export function clearAllNotes(): void {
  saveAll([])
  console.log('[polyshield:notes] all notes cleared')
}

export function formatUsdc(micro: bigint): string {
  const whole = micro / 1_000_000n
  const frac = micro % 1_000_000n
  return `${whole.toLocaleString()}.${frac.toString().padStart(6, '0').slice(0, 2)}`
}
