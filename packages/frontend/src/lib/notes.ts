/**
 * Client-side note management.
 *
 * A "note" is the private state a depositor holds: (secret, balance, nonce, owner_address).
 * Commitment = Poseidon4(secret, balance, nonce, owner_address)  — matches Noir's bn254::hash_4
 * Nullifier  = Poseidon2(secret, nonce)                         — matches Noir's bn254::hash_2
 *
 * Secrets are wallet-derived — never random, never stored in localStorage.
 * Derive with deriveSecret(signMessageAsync, address, index).
 * Notes are stored in localStorage under key "polyshield:notes".
 * NEVER send note preimages (secret, balance, nonce) to any server.
 */

import { poseidon2, poseidon4 } from 'poseidon-lite'
import {
  createPublicClient,
  http,
  keccak256,
  parseAbiItem,
  toBytes,
  type PublicClient,
} from 'viem'

export type NoteKind = 'DEPOSIT' | 'BET_OUTPUT' | 'SETTLE_CREDIT' | 'CANCEL_CREDIT' | 'BET_RECEIPT'

export type WalletActivityKind = 'deposit' | 'withdrawal' | 'bet' | 'settlement' | 'refund'

export interface Note {
  id: string
  kind: NoteKind
  owner_address: `0x${string}`
  depositIndex: number
  balance: bigint
  nonce: bigint
  commitment: `0x${string}`
  nullifier: `0x${string}`
  spent: boolean
  createdAt: number
  leafIndex?: number
  txHash?: string
  marketId?: string
  side?: 'YES' | 'NO'
  expectedShares?: bigint
  /** Nullifier of the note spent at bet auth (Vault betRecords key). */
  nullifier_of_bet?: `0x${string}`
  /** CTF conditionId reduced to BN254 field — the circuit_key used by the Vault. */
  condition_id?: `0x${string}`
  /** Raw unreduced conditionId (keccak256). Use this to recompute circuit_key with correct BN254_P. */
  raw_condition_id?: `0x${string}`
  bet_amount?: bigint
}

export interface ReadyToSettleBet {
  receipt: Note
  payoutPerShare: bigint
  claimAmount: bigint
}

export interface WalletActivityEvent {
  id: string
  wallet: `0x${string}`
  kind: WalletActivityKind
  amount: bigint
  createdAt: number
  txHash?: string
  marketId?: `0x${string}`
  side?: 'YES' | 'NO'
  receiptId?: string
  receiptNullifier?: `0x${string}`
  noteId?: string
  payout?: bigint
  destination?: `0x${string}`
}

const STORAGE_KEY = 'polyshield:notes'
const INDEX_KEY_PREFIX = 'polyshield:deposit_index:'
const ACTIVITY_STORAGE_KEY = 'polyshield:activity'
const LAST_BLOCK_KEY = 'polyshield:last_block'

let cachedNotes: Note[] | null = null
let cachedActivity: WalletActivityEvent[] | null = null

export const BN254_P = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n

/** Protocol constant — do not change after mainnet deployment. */
export function derivationMessage(address: string, index: number): string {
  return `PolyShield deposit derivation\nAddress: ${address}\nIndex: ${index}\nVersion: 1`
}

function loadAll(): Note[] {
  if (typeof window === 'undefined') return []
  if (cachedNotes) return cachedNotes
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as Array<Record<string, unknown>>
    cachedNotes = arr.map((n) => ({
      ...n,
      balance: BigInt(n.balance as string),
      nonce: BigInt(n.nonce as string),
      ...(n.expectedShares != null ? { expectedShares: BigInt(n.expectedShares as string) } : {}),
      ...(n.bet_amount != null ? { bet_amount: BigInt(n.bet_amount as string) } : {}),
    })) as Note[]
    return cachedNotes
  } catch {
    return []
  }
}

function saveAll(notes: Note[]): void {
  if (typeof window === 'undefined') return
  cachedNotes = notes
  const serialized = notes.map((n) => ({
    ...n,
    balance: n.balance.toString(),
    nonce: n.nonce.toString(),
    ...(n.expectedShares != null ? { expectedShares: n.expectedShares.toString() } : {}),
    ...(n.bet_amount != null ? { bet_amount: n.bet_amount.toString() } : {}),
  }))
  localStorage.setItem(STORAGE_KEY, JSON.stringify(serialized))
}

function sameAddress(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  return a.toLowerCase() === b.toLowerCase()
}

function loadActivity(): WalletActivityEvent[] {
  if (typeof window === 'undefined') return []
  if (cachedActivity) return cachedActivity
  try {
    const raw = localStorage.getItem(ACTIVITY_STORAGE_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as Array<Record<string, unknown>>
    cachedActivity = arr.map((event) => ({
      ...event,
      amount: BigInt(event.amount as string),
      ...(event.payout != null ? { payout: BigInt(event.payout as string) } : {}),
    })) as WalletActivityEvent[]
    return cachedActivity
  } catch {
    return []
  }
}

function saveActivity(events: WalletActivityEvent[]): void {
  if (typeof window === 'undefined') return
  cachedActivity = events
  const serialized = events.map((event) => ({
    ...event,
    amount: event.amount.toString(),
    ...(event.payout != null ? { payout: event.payout.toString() } : {}),
  }))
  localStorage.setItem(ACTIVITY_STORAGE_KEY, JSON.stringify(serialized))
}

export function getNotes(): Note[] {
  return loadAll()
}

export function getWalletNotes(wallet: `0x${string}`): Note[] {
  return loadAll().filter((n) => sameAddress(n.owner_address, wallet))
}

/** Free-balance notes only (excludes BET_RECEIPT tracking notes). */
export function getSpendableNotes(wallet?: `0x${string}`): Note[] {
  return loadAll().filter(
    (n) =>
      !n.spent &&
      n.kind !== 'BET_RECEIPT' &&
      (!wallet || sameAddress(n.owner_address, wallet)),
  )
}

export function getFreeNotes(wallet: `0x${string}`): Note[] {
  return getSpendableNotes(wallet)
}

export function getCashBalance(wallet: `0x${string}`): bigint {
  return getFreeNotes(wallet).reduce((sum, n) => sum + n.balance, 0n)
}

export function getCurrentCashNote(wallet: `0x${string}`): Note | null {
  const freeNotes = getFreeNotes(wallet)
  if (freeNotes.length === 0) return null
  return freeNotes.sort((a, b) => (a.balance > b.balance ? -1 : 1))[0] ?? null
}

/**
 * Return the current free note for a specific deposit index — i.e., the
 * highest-nonce unspent note in that deposit's chain. Used by settlement to
 * ensure the correct secret is derived; settlement proofs require
 * Poseidon(secret, nonce−1) === nullifier_of_bet, which only holds when the
 * note comes from the same deposit chain as the bet receipt.
 */
export function getFreeNoteForDeposit(wallet: `0x${string}`, depositIndex: number): Note | null {
  const notes = getSpendableNotes(wallet).filter((n) => n.depositIndex === depositIndex)
  if (notes.length === 0) return null
  return notes.sort((a, b) => (a.nonce > b.nonce ? -1 : 1))[0] ?? null
}

export function getOpenBetReceipts(wallet: `0x${string}`): Note[] {
  return loadAll().filter(
    (n) =>
      !n.spent &&
      n.kind === 'BET_RECEIPT' &&
      sameAddress(n.owner_address, wallet),
  )
}

export function clearNoteCache(): void {
  cachedNotes = null
  cachedActivity = null
}

export function getWalletActivity(wallet: `0x${string}`): WalletActivityEvent[] {
  return loadActivity()
    .filter((event) => sameAddress(event.wallet, wallet))
    .sort((a, b) => a.createdAt - b.createdAt)
}

export function recordWalletActivity(event: WalletActivityEvent): void {
  const events = loadActivity()
  const next = [...events, event]
  saveActivity(next)
}

export function clearWalletActivity(): void {
  saveActivity([])
}

function bigIntToField(n: bigint): string {
  return `0x${n.toString(16).padStart(64, '0')}`
}

export async function deriveSecret(
  signMessageAsync: (args: { message: string }) => Promise<`0x${string}`>,
  address: `0x${string}`,
  index: number,
): Promise<`0x${string}`> {
  const message = derivationMessage(address, index)
  const sig = await signMessageAsync({ message })
  const hash = keccak256(toBytes(sig))
  const val = BigInt(hash) % BN254_P
  return bigIntToField(val === 0n ? 1n : val) as `0x${string}`
}

export function getNextDepositIndex(address: `0x${string}`): number {
  if (typeof window === 'undefined') return 0
  const key = INDEX_KEY_PREFIX + address.toLowerCase()
  return parseInt(localStorage.getItem(key) ?? '0', 10)
}

export function incrementDepositIndex(address: `0x${string}`): void {
  if (typeof window === 'undefined') return
  const key = INDEX_KEY_PREFIX + address.toLowerCase()
  const next = getNextDepositIndex(address) + 1
  localStorage.setItem(key, next.toString())
}

export function computeCommitment(
  secret: `0x${string}`,
  balance: bigint,
  nonce: bigint,
  owner_address: `0x${string}`,
): `0x${string}` {
  const s = BigInt(secret)
  const a = BigInt(owner_address)
  const hash = poseidon4([s, balance, nonce, a])
  return bigIntToField(hash) as `0x${string}`
}

export function computeNullifier(
  secret: `0x${string}`,
  nonce: bigint,
): `0x${string}` {
  const s = BigInt(secret)
  const hash = poseidon2([s, nonce])
  return bigIntToField(hash) as `0x${string}`
}

export function computeRecipientHash(recipientAddress: `0x${string}`): `0x${string}` {
  const addrBigInt = BigInt(recipientAddress)
  const hash = poseidon2([addrBigInt, 0n])
  return bigIntToField(hash) as `0x${string}`
}

type ChainNoteState = {
  secret: `0x${string}`
  depositIndex: number
  balance: bigint
  nonce: bigint
  commitment: `0x${string}`
  nullifier: `0x${string}`
  kind: NoteKind
  spent: boolean
}

const depositedEvent = parseAbiItem(
  'event Deposited(address indexed depositor, bytes32 commitment, uint256 amount)',
)
const betAuthorizedEvent = parseAbiItem(
  'event BetAuthorized(bytes32 indexed nullifier, bytes32 market_id, bytes32 position_id, uint64 expected_shares, uint256 bet_amount, uint64 price, uint8 outcome_side, bytes32 new_commitment)',
)
const settlementCreditedEvent = parseAbiItem(
  'event SettlementCredited(bytes32 indexed nullifier, bytes32 nullifier_of_bet, bytes32 new_commitment)',
)
const betCancelEvent = parseAbiItem(
  'event BetCancellationCredited(bytes32 indexed nullifier, bytes32 nullifier_of_bet, bytes32 new_commitment)',
)
const naCancelEvent = parseAbiItem(
  'event NACancellationCredited(bytes32 indexed nullifier, bytes32 nullifier_of_bet, bytes32 new_commitment)',
)
const withdrawnEvent = parseAbiItem(
  'event Withdrawn(bytes32 indexed nullifier, address recipient, uint256 amount, bytes32 new_commitment)',
)

/**
 * Reconstruct notes by scanning on-chain Vault events and replaying state per deposit index.
 */
export async function recoverNotes(
  address: `0x${string}`,
  signMessageAsync: (args: { message: string }) => Promise<`0x${string}`>,
  vaultAddress: `0x${string}`,
  rpcUrl = process.env.NEXT_PUBLIC_CHAIN_RPC ?? 'http://127.0.0.1:8545',
  maxIndex = 10,
): Promise<Note[]> {
  const client = createPublicClient({ transport: http(rpcUrl) })
  return recoverNotesWithClient(address, signMessageAsync, client, vaultAddress, maxIndex)
}

export async function recoverNotesWithClient(
  address: `0x${string}`,
  signMessageAsync: (args: { message: string }) => Promise<`0x${string}`>,
  client: PublicClient,
  vaultAddress: `0x${string}`,
  maxIndex = 10,
): Promise<Note[]> {
  const fromBlock = 0n
  const [deposits, bets, settlements, betCancels, naCancels, withdrawals] = await Promise.all([
    client.getLogs({ address: vaultAddress, event: depositedEvent, args: { depositor: address }, fromBlock }),
    client.getLogs({ address: vaultAddress, event: betAuthorizedEvent, fromBlock }),
    client.getLogs({ address: vaultAddress, event: settlementCreditedEvent, fromBlock }),
    client.getLogs({ address: vaultAddress, event: betCancelEvent, fromBlock }),
    client.getLogs({ address: vaultAddress, event: naCancelEvent, fromBlock }),
    client.getLogs({ address: vaultAddress, event: withdrawnEvent, fromBlock }),
  ])

  const recovered: Note[] = []
  const receiptByBetNullifier = new Map<string, Note>()

  for (let index = 0; index < maxIndex; index++) {
    const secret = await deriveSecret(signMessageAsync, address, index)
    const deposit = deposits.find((d) => {
      const amt = d.args.amount!
      const c = computeCommitment(secret, amt, 0n, address)
      return c.toLowerCase() === d.args.commitment!.toLowerCase()
    })
    if (!deposit) continue

    let state: ChainNoteState = {
      secret,
      depositIndex: index,
      balance: deposit.args.amount!,
      nonce: 0n,
      commitment: deposit.args.commitment! as `0x${string}`,
      nullifier: computeNullifier(secret, 0n),
      kind: 'DEPOSIT',
      spent: false,
    }

    const pushFree = (s: ChainNoteState, txHash?: string) => {
      recovered.push({
        id: s.commitment,
        kind: s.kind,
        owner_address: address,
        depositIndex: index,
        balance: s.balance,
        nonce: s.nonce,
        commitment: s.commitment,
        nullifier: s.nullifier,
        spent: s.spent,
        createdAt: Date.now(),
        txHash,
      })
    }

    const events = [
      ...bets.map((e) => ({ type: 'bet' as const, block: e.blockNumber!, tx: e.transactionHash, args: e.args })),
      ...settlements.map((e) => ({ type: 'settle' as const, block: e.blockNumber!, tx: e.transactionHash, args: e.args })),
      ...betCancels.map((e) => ({ type: 'betCancel' as const, block: e.blockNumber!, tx: e.transactionHash, args: e.args })),
      ...naCancels.map((e) => ({ type: 'naCancel' as const, block: e.blockNumber!, tx: e.transactionHash, args: e.args })),
      ...withdrawals
        .filter((e) => sameAddress(e.args.recipient!, address))
        .map((e) => ({ type: 'withdraw' as const, block: e.blockNumber!, tx: e.transactionHash, args: e.args })),
    ].sort((a, b) => {
      if (a.block !== b.block) return Number(a.block - b.block)
      return (a.tx ?? '').localeCompare(b.tx ?? '')
    })

    for (const ev of events) {
      if (ev.type === 'bet') {
        const betNull = ev.args.nullifier! as `0x${string}`
        if (betNull.toLowerCase() !== state.nullifier.toLowerCase() || state.spent) continue

        const betAmount = ev.args.bet_amount!
        const newBalance = state.balance - betAmount
        const newNonce = state.nonce + 1n
        const newCommitment = ev.args.new_commitment! as `0x${string}`

        state.spent = true
        pushFree(state, ev.tx)

        const receiptId = `receipt-${betNull}` as `0x${string}`
        const receipt: Note = {
          id: receiptId,
          kind: 'BET_RECEIPT',
          owner_address: address,
          depositIndex: index,
          balance: betAmount,
          nonce: state.nonce,
          commitment: receiptId,
          nullifier: betNull,
          nullifier_of_bet: betNull,
          condition_id: ev.args.market_id! as `0x${string}`,
          bet_amount: betAmount,
          expectedShares: ev.args.expected_shares,
          spent: false,
          createdAt: Date.now(),
          txHash: ev.tx,
        }
        recovered.push(receipt)
        receiptByBetNullifier.set(betNull.toLowerCase(), receipt)

        state = {
          secret,
          depositIndex: index,
          balance: newBalance,
          nonce: newNonce,
          commitment: newCommitment,
          nullifier: computeNullifier(secret, newNonce),
          kind: 'BET_OUTPUT',
          spent: false,
        }
      } else if (ev.type === 'settle' || ev.type === 'betCancel' || ev.type === 'naCancel') {
        const spentNull = ev.args.nullifier! as `0x${string}`
        if (spentNull.toLowerCase() !== state.nullifier.toLowerCase() || state.spent) continue

        const betNull = ev.args.nullifier_of_bet! as string
        const receipt = receiptByBetNullifier.get(betNull.toLowerCase())
        if (receipt) receipt.spent = true

        const oldBalance = state.balance
        state.spent = true
        pushFree(state, ev.tx)

        const newNonce = state.nonce + 1n
        const newCommitment = ev.args.new_commitment! as `0x${string}`
        let newBalance = oldBalance

        if (ev.type === 'settle' && receipt?.expectedShares) {
          try {
            const payout = await client.readContract({
              address: vaultAddress,
              abi: [{ type: 'function', name: 'pendingCredit', inputs: [{ type: 'bytes32' }, { type: 'uint8' }], outputs: [{ type: 'uint64' }], stateMutability: 'view' }],
              functionName: 'pendingCredit',
              args: [receipt.condition_id!, receipt.side === 'NO' ? 1 : 0],
            }) as bigint
            newBalance = oldBalance + receipt.expectedShares * payout
          } catch {
            newBalance = inferBalanceFromCommitment(secret, newNonce, address, newCommitment) ?? oldBalance
          }
        } else if (receipt?.bet_amount) {
          newBalance = oldBalance + receipt.bet_amount
        } else {
          newBalance = inferBalanceFromCommitment(secret, newNonce, address, newCommitment) ?? oldBalance
        }

        state = {
          secret,
          depositIndex: index,
          balance: newBalance,
          nonce: newNonce,
          commitment: newCommitment,
          nullifier: computeNullifier(secret, newNonce),
          kind: ev.type === 'settle' ? 'SETTLE_CREDIT' : 'CANCEL_CREDIT',
          spent: false,
        }
      } else if (ev.type === 'withdraw') {
        const spentNull = ev.args.nullifier! as `0x${string}`
        if (spentNull.toLowerCase() !== state.nullifier.toLowerCase() || state.spent) continue
        const oldBalance = state.balance
        state.spent = true
        pushFree(state, ev.tx)

        const withdrawalAmount = ev.args.amount!
        const newCommitment = ev.args.new_commitment! as `0x${string}`
        const hasRemainder = newCommitment !== (`0x${'00'.repeat(32)}` as `0x${string}`)

        if (!hasRemainder) {
          state = {
            ...state,
            balance: 0n,
            spent: true,
          }
          continue
        }

        const newNonce = state.nonce + 1n
        const remainingBalance = oldBalance - withdrawalAmount

        state = {
          secret,
          depositIndex: index,
          balance: remainingBalance,
          nonce: newNonce,
          commitment: newCommitment,
          nullifier: computeNullifier(secret, newNonce),
          kind: 'BET_OUTPUT',
          spent: false,
        }
      }
    }

    if (!state.spent && state.balance > 0n) {
      pushFree(state)
    }
  }

  saveAll(recovered)
  return recovered
}

function inferBalanceFromCommitment(
  _secret: `0x${string}`,
  _nonce: bigint,
  _owner: `0x${string}`,
  _commitment: `0x${string}`,
): bigint | null {
  // Balance cannot be inferred by brute-force: non-integer-USDC balances (e.g. after
  // fee deductions) would never be found, and the 50k-iteration loop freezes the UI.
  // Callers should recover balance from on-chain event data instead.
  return null
}

/** @deprecated Use conditionId bytes32 for on-chain market_id. Display-only hash. */
export function marketToField(label: string): `0x${string}` {
  const enc = new TextEncoder().encode(label)
  let h = 5381n
  for (const b of enc) {
    h = ((h << 5n) + h + BigInt(b)) & ((1n << 256n) - 1n)
  }
  return bigIntToField(h % BN254_P) as `0x${string}`
}

/** Position id for bet auth — uses conditionId + side. */
export function positionToField(conditionId: string, side: string): `0x${string}` {
  const enc = new TextEncoder().encode(`${conditionId}:${side}`)
  let h = 5381n
  for (const b of enc) {
    h = ((h << 5n) + h + BigInt(b)) & ((1n << 256n) - 1n)
  }
  return bigIntToField(h % BN254_P) as `0x${string}`
}

/** Normalize a condition id to bytes32 hex. */
export function normalizeConditionId(id: string): `0x${string}` {
  const hex = id.startsWith('0x') ? id.slice(2) : id
  return `0x${hex.padStart(64, '0').slice(-64)}` as `0x${string}`
}

function notifyNotesChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('polyshield:notes-changed'))
  }
}

export function markNoteSpent(commitment: `0x${string}`): void {
  const notes = loadAll()
  const idx = notes.findIndex((n) => n.commitment === commitment || n.id === commitment)
  if (idx >= 0) {
    notes[idx].spent = true
    saveAll(notes)
    notifyNotesChanged()
  }
}

export function markBetReceiptSpent(nullifierOfBet: `0x${string}`): void {
  const notes = loadAll()
  const idx = notes.findIndex(
    (n) =>
      n.kind === 'BET_RECEIPT' &&
      (n.nullifier_of_bet === nullifierOfBet || n.nullifier === nullifierOfBet),
  )
  if (idx >= 0) {
    notes[idx].spent = true
    saveAll(notes)
    notifyNotesChanged()
  }
}

export function addNote(note: Note): void {
  const notes = loadAll()
  notes.push(note)
  saveAll(notes)
  notifyNotesChanged()
}

export function replaceNote(noteId: string, next: Note): void {
  const notes = loadAll()
  const idx = notes.findIndex((n) => n.id === noteId || n.commitment === noteId)
  if (idx >= 0) {
    notes[idx] = next
  } else {
    notes.push(next)
  }
  saveAll(notes)
  notifyNotesChanged()
}

export function clearAllNotes(): void {
  clearNoteCache()
  saveAll([])
}

export function formatUsdc(micro: bigint): string {
  const negative = micro < 0n
  const abs = negative ? -micro : micro
  const whole = abs / 1_000_000n
  const frac = abs % 1_000_000n
  const sign = negative ? '-' : ''
  return `${sign}${whole.toLocaleString()}.${frac.toString().padStart(6, '0').slice(0, 2)}`
}

/**
 * Reduce an externally-sourced bytes32 hex value into the BN254 scalar field.
 * Use this for keccak256-derived values (condition IDs, position IDs) that may
 * exceed the field modulus and would trigger "Input exceeds field modulus" in Noir.
 */
export function toFieldSafe(hex: string): string {
  const reduced = BigInt(hex) % BN254_P
  return '0x' + reduced.toString(16).padStart(64, '0')
}

/**
 * Derive the Vault circuit_key for a market given a receipt Note.
 * Handles three cases in priority order:
 *  1. raw_condition_id present → apply toFieldSafe to the raw keccak256 (always correct)
 *  2. marketId is a non-hex slug → keccak256(slug) → toFieldSafe (fixes old receipts)
 *  3. condition_id present → apply toFieldSafe (may be pre-fix value, last resort)
 */
export function receiptCircuitKey(receipt: { condition_id?: `0x${string}`; raw_condition_id?: `0x${string}`; marketId?: string }): `0x${string}` | null {
  if (receipt.raw_condition_id) {
    return toFieldSafe(receipt.raw_condition_id) as `0x${string}`
  }
  if (receipt.marketId && !receipt.marketId.startsWith('0x')) {
    return toFieldSafe(keccak256(toBytes(receipt.marketId))) as `0x${string}`
  }
  if (receipt.condition_id) {
    return toFieldSafe(receipt.condition_id) as `0x${string}`
  }
  return null
}

// ── Chain-reset detection ─────────────────────────────────────────────────────

export function getLastSeenBlock(): number {
  if (typeof window === 'undefined') return 0
  return parseInt(localStorage.getItem(LAST_BLOCK_KEY) ?? '0', 10)
}

export function setLastSeenBlock(block: number): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(LAST_BLOCK_KEY, block.toString())
}

/**
 * Wipe all locally-cached protocol state: notes, activity log, and deposit
 * index counters. Called automatically when a chain reset is detected (block
 * number decreased), or can be called manually from a dev UI.
 *
 * The last-seen block is also cleared so the next `setLastSeenBlock` call
 * starts fresh without triggering another spurious reset detection.
 */
export function resetAllLocalState(): void {
  if (typeof window === 'undefined') return
  // Clear notes and activity
  cachedNotes = null
  cachedActivity = null
  localStorage.removeItem(STORAGE_KEY)
  localStorage.removeItem(ACTIVITY_STORAGE_KEY)
  localStorage.removeItem(LAST_BLOCK_KEY)
  // Clear all deposit-index counters (may be one per wallet address)
  const toRemove: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key?.startsWith(INDEX_KEY_PREFIX)) toRemove.push(key)
  }
  toRemove.forEach((k) => localStorage.removeItem(k))
}
