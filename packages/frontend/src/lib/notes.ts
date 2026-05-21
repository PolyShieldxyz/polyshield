/**
 * Client-side note management.
 *
 * A "note" is the private state a depositor holds: (secret, balance, nonce).
 * Commitment = keccak256(secret, balance, nonce) in dev mode (production uses Poseidon WASM).
 * Nullifier  = keccak256(secret, nonce) in dev mode.
 *
 * Notes are stored in localStorage under key "polyshield:notes".
 * NEVER send note preimages (secret, balance, nonce) to any server.
 */

import { keccak256, encodePacked, hexToBigInt } from 'viem'

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
}

const STORAGE_KEY = 'polyshield:notes'

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
  }))
  localStorage.setItem(STORAGE_KEY, JSON.stringify(serialized))
}

export function getNotes(): Note[] {
  return loadAll()
}

export function getSpendableNotes(): Note[] {
  return loadAll().filter((n) => !n.spent)
}

// Dev-mode commitment: keccak256(secret ++ balance_as_bytes32 ++ nonce_as_bytes32)
export function computeCommitment(
  secret: `0x${string}`,
  balance: bigint,
  nonce: bigint,
): `0x${string}` {
  return keccak256(
    encodePacked(
      ['bytes32', 'uint256', 'uint256'],
      [secret, balance, nonce],
    )
  )
}

// Dev-mode nullifier: keccak256(secret ++ nonce_as_bytes32)
export function computeNullifier(
  secret: `0x${string}`,
  nonce: bigint,
): `0x${string}` {
  return keccak256(encodePacked(['bytes32', 'uint256'], [secret, nonce]))
}

export function generateSecret(): `0x${string}` {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return `0x${Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')}`
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
