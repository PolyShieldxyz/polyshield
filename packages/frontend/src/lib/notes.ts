/**
 * Client-side note management.
 *
 * A "note" is the private state a depositor holds: (secret, balance, nonce, owner_address).
 * Commitment = Poseidon4(secret, balance, nonce, owner_address)  — matches Noir's bn254::hash_4
 * Nullifier  = Poseidon2(secret, nonce)                         — matches Noir's bn254::hash_2
 *
 * Secrets are wallet-derived — never random, never persisted (no localStorage, no IndexedDB).
 *  - V2 (FC-13, default): one master-seed signature per session → all secrets derived locally.
 *    Use getNoteSecret()/getMasterSeed() in secretSession.ts; the pure primitives live here
 *    (deriveMasterSeed / deriveSecretV2). The seed is held in memory only (secretSession.ts).
 *  - V1 (legacy): one signature per deposit index via deriveSecret()/deriveSecretV1().
 * The note CACHE (commitments/balances/nonces/linkage — NOT secrets) is persisted ENCRYPTED in
 * IndexedDB via cacheStore.ts; the in-memory cache (cachedNotes/cachedActivity) is the synchronous
 * working set, hydrated once on app start by hydrateCache(). NEVER send note preimages to a server.
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
import { fetchSpentNullifiers, fetchBetStatus, BET_STATUS } from './api'
import { readEncrypted, writeEncrypted, removeEncrypted } from './cacheStore'
import { CLOSE_MARKER_KEY_PREFIX } from './closeMarker'
import { WITHDRAW_MARKER_KEY_PREFIX } from './withdrawMarker'
import { DEPOSIT_MARKER_KEY_PREFIX } from './depositMarker'

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
  /** Human-readable market question (e.g. "Will USA win the 2026 FIFA World Cup?"), captured at
   *  bet time for display. Recovered/legacy receipts may lack it → resolve from the catalog by
   *  raw_condition_id. NOT a protocol field; display-only. */
  marketName?: string
  side?: 'YES' | 'NO'
  /** Human-readable outcome label the user bet on (e.g. a team name), for head-to-head markets where
   *  "YES"/"NO" is meaningless. Display-only; `side` still drives outcome_side 0/1. */
  sideLabel?: string
  expectedShares?: bigint
  /** Nullifier of the note spent at bet auth (Vault betRecords key). */
  nullifier_of_bet?: `0x${string}`
  /** CTF position/token id for the bet (FC-1: needed to submit a market SELL to close). */
  position_id?: `0x${string}`
  /** CTF conditionId reduced to BN254 field — the circuit_key used by the Vault. */
  condition_id?: `0x${string}`
  /** Raw unreduced conditionId (keccak256). Use this to recompute circuit_key with correct BN254_P. */
  raw_condition_id?: `0x${string}`
  bet_amount?: bigint
  /** FC-14: protocol fee charged on this bet (on BET_RECEIPT notes) — drives the cancel/partial refund. */
  protocolFee?: bigint
  /**
   * FC-13: which secret-derivation scheme produced this lineage's secret.
   *  2 = V2 master-seed (new deposits); 1 = legacy per-index. Undefined → treated as V1
   *  (pre-FC-13 cached notes). A whole deposit lineage shares one version; children inherit it.
   */
  derivationVersion?: 1 | 2
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
  /** Human-readable market question, captured at bet time (#5). Threaded into closed-bet history rows
   *  for display; falls back to a catalog lookup by conditionId, then the raw id. */
  marketName?: string
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
const CHAIN_FP_KEY = 'polyshield:chain_fp'

// In-memory working set — the SYNCHRONOUS source of truth for all reads. Populated once on app
// start by hydrateCache() (async, from encrypted IndexedDB) and updated synchronously on every
// write (which also fire-and-forget persists to IndexedDB). null = not yet hydrated.
let cachedNotes: Note[] | null = null
let cachedActivity: WalletActivityEvent[] | null = null
let hydrated = false

export const BN254_P = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n

/**
 * V1 (legacy) per-index derivation message. Protocol constant — frozen; never change for
 * already-deposited V1 notes. New deposits use the V2 master seed (see masterSeedMessageV2).
 */
export function derivationMessage(address: string, index: number): string {
  return `PolyShield deposit derivation\nAddress: ${address}\nIndex: ${index}\nVersion: 1`
}

/**
 * V2 (FC-13) master-seed message. Signed ONCE per session; the resulting seed derives every note
 * secret locally (deriveSecretV2). Protocol constant — frozen after mainnet; never change it.
 */
export function masterSeedMessageV2(address: string): string {
  return `PolyShield master seed\nAddress: ${address}\nVersion: 2`
}

// ── Note-cache (de)serialization (shared by persistence + hydration) ──────────
function serializeNotes(notes: Note[]): string {
  return JSON.stringify(
    notes.map((n) => ({
      ...n,
      balance: n.balance.toString(),
      nonce: n.nonce.toString(),
      ...(n.expectedShares != null ? { expectedShares: n.expectedShares.toString() } : {}),
      ...(n.bet_amount != null ? { bet_amount: n.bet_amount.toString() } : {}),
      ...(n.protocolFee != null ? { protocolFee: n.protocolFee.toString() } : {}),
    })),
  )
}

function deserializeNotes(raw: string): Note[] {
  const arr = JSON.parse(raw) as Array<Record<string, unknown>>
  return arr.map((n) => ({
    ...n,
    balance: BigInt(n.balance as string),
    nonce: BigInt(n.nonce as string),
    ...(n.expectedShares != null ? { expectedShares: BigInt(n.expectedShares as string) } : {}),
    ...(n.bet_amount != null ? { bet_amount: BigInt(n.bet_amount as string) } : {}),
    ...(n.protocolFee != null ? { protocolFee: BigInt(n.protocolFee as string) } : {}),
  })) as Note[]
}

function serializeActivity(events: WalletActivityEvent[]): string {
  return JSON.stringify(
    events.map((event) => ({
      ...event,
      amount: event.amount.toString(),
      ...(event.payout != null ? { payout: event.payout.toString() } : {}),
    })),
  )
}

function deserializeActivity(raw: string): WalletActivityEvent[] {
  const arr = JSON.parse(raw) as Array<Record<string, unknown>>
  return arr.map((event) => ({
    ...event,
    amount: BigInt(event.amount as string),
    ...(event.payout != null ? { payout: BigInt(event.payout as string) } : {}),
  })) as WalletActivityEvent[]
}

/**
 * FC-13: one-time import of any legacy PLAINTEXT localStorage cache into encrypted IndexedDB,
 * then delete the plaintext copies. Existing users keep their notes/activity with no recovery,
 * and nothing sensitive is left readable in localStorage afterward.
 */
async function migrateLegacyLocalStorage(): Promise<void> {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return
  // Persist each legacy plaintext key into the encrypted store, then drop the plaintext ONLY after
  // verifying the encrypted copy reads back. If IndexedDB is unavailable (e.g. private mode) or the
  // write fails, the plaintext is left intact rather than destroyed — never lose the cache here
  // (and funds are chain-recoverable regardless).
  const migrateKey = async (key: string) => {
    try {
      const legacy = localStorage.getItem(key)
      if (legacy == null) return
      if ((await readEncrypted(key)) == null) await writeEncrypted(key, legacy)
      if ((await readEncrypted(key)) != null) localStorage.removeItem(key)
    } catch {
      /* best-effort; keep the plaintext on any failure */
    }
  }
  await migrateKey(STORAGE_KEY)
  await migrateKey(ACTIVITY_STORAGE_KEY)
}

/**
 * FC-13: populate the in-memory caches from encrypted IndexedDB. Idempotent — skips if already
 * populated in memory (so it never clobbers unflushed writes). Call once on app start (and after a
 * clearNoteCache) BEFORE rendering note-reading UI; see useNotesHydration / app/app/layout.tsx.
 */
export async function hydrateCache(): Promise<void> {
  if (typeof window === 'undefined') return
  if (cachedNotes !== null) {
    hydrated = true
    return
  }
  await migrateLegacyLocalStorage()
  try {
    const notesRaw = await readEncrypted(STORAGE_KEY)
    cachedNotes = notesRaw ? deserializeNotes(notesRaw) : []
  } catch {
    cachedNotes = []
  }
  try {
    const actRaw = await readEncrypted(ACTIVITY_STORAGE_KEY)
    cachedActivity = actRaw ? deserializeActivity(actRaw) : []
  } catch {
    cachedActivity = []
  }
  hydrated = true
}

/** True once the encrypted cache has been read into memory (or there was nothing to read). */
export function isHydrated(): boolean {
  return hydrated || cachedNotes !== null
}

function loadAll(): Note[] {
  // Reads are synchronous against the in-memory working set. Before hydration completes this
  // returns [] (the app gates note-reading UI on hydration); writes set the cache synchronously.
  return cachedNotes ?? []
}

function saveAll(notes: Note[]): void {
  if (typeof window === 'undefined') return
  cachedNotes = notes
  hydrated = true
  void writeEncrypted(STORAGE_KEY, serializeNotes(notes))
}

function sameAddress(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  return a.toLowerCase() === b.toLowerCase()
}

function loadActivity(): WalletActivityEvent[] {
  return cachedActivity ?? []
}

function saveActivity(events: WalletActivityEvent[]): void {
  if (typeof window === 'undefined') return
  cachedActivity = events
  hydrated = true
  void writeEncrypted(ACTIVITY_STORAGE_KEY, serializeActivity(events))
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

/** Max input notes a single consolidate proof can merge (matches consolidate.circom K). */
export const MAX_CONSOLIDATE_INPUTS = 4

export interface NoteSelection {
  notes: Note[]
  total: bigint
}

/**
 * FC-8: pick up to MAX_CONSOLIDATE_INPUTS free notes (largest-first) whose balances
 * sum to >= `amount`, for a consolidate-then-spend flow. Returns an error when even the
 * largest 4 notes cannot cover the amount in one merge. The largest selected note is
 * placed first (slot 0) so the merged note continues its lineage.
 *
 * Option A (stranding-safety): a consolidate continues slot-0's lineage and spends the rest, so a
 * note whose deposit still holds an OPEN POSITION must never be merged away as a non-slot-0 input —
 * its settlement/close payout can only land on a note in its own lineage, and merging it away strands
 * that payout permanently. When `opts.openPositionDeposits` is supplied the selection therefore
 * prefers CLEAR notes and admits AT MOST ONE open-position lineage, forced to slot 0 so the merged
 * note continues it (kept alive; the caller drains it only to a dust remainder). This mirrors the
 * `safeMax` the withdraw page uses to gate the button, so selection and the hard-block never disagree.
 */
export function selectNotesForAmount(
  wallet: `0x${string}`,
  amount: bigint,
  opts?: { openPositionDeposits?: Set<number>; preferredSlot0DepositIndex?: number },
): { ok: true; selection: NoteSelection } | { ok: false; error: string } {
  const all = getFreeNotes(wallet).sort((a, b) => (a.balance > b.balance ? -1 : 1))
  if (all.length === 0) return { ok: false, error: 'No spendable notes.' }

  const picked: Note[] = []
  let total = 0n
  const tryAdd = (n: Note): void => {
    if (total >= amount || picked.length >= MAX_CONSOLIDATE_INPUTS) return
    picked.push(n)
    total += n.balance
  }

  // Default to the wallet's own open-position deposits so EVERY consolidation path (withdraw, bet, …)
  // is stranding-safe — not only callers that remember to pass the set. An explicit set overrides
  // (the withdraw page passes its already-computed set, which equals this default).
  const openDeposits =
    opts?.openPositionDeposits ?? new Set(getOpenBetReceipts(wallet).map((r) => r.depositIndex))
  let slot0Deposit = opts?.preferredSlot0DepositIndex
  if (openDeposits.size > 0) {
    const clear = all.filter((n) => !openDeposits.has(n.depositIndex))
    const open = all.filter((n) => openDeposits.has(n.depositIndex))
    // Prefer a clear-only merge when the 4 largest clear notes already cover the amount (don't disturb
    // an open lineage needlessly). Otherwise admit the single largest open note (4-largest of clear ∪
    // that note) and force it to slot 0 below so its lineage survives the merge.
    const clearCovers =
      clear.slice(0, MAX_CONSOLIDATE_INPUTS).reduce((s, n) => s + n.balance, 0n) >= amount
    const pool =
      clearCovers || !open[0]
        ? clear
        : [...clear, open[0]].sort((a, b) => (a.balance > b.balance ? -1 : 1))
    for (const n of pool) tryAdd(n)
    const usedOpen = picked.find((n) => openDeposits.has(n.depositIndex))
    if (usedOpen) slot0Deposit = usedOpen.depositIndex
  } else {
    for (const n of all) tryAdd(n)
  }

  if (total < amount) {
    const reachable =
      openDeposits.size > 0
        ? total
        : all.slice(0, MAX_CONSOLIDATE_INPUTS).reduce((s, n) => s + n.balance, 0n)
    return {
      ok: false,
      error:
        `This amount can't be combined in one step without stranding an open position ` +
        `(reachable safely in one merge: ${reachable}, need ${amount}). ` +
        `Use "Settle & Withdraw" to clear your open positions, or withdraw a smaller amount.`,
    }
  }

  // Force the slot-0 lineage to index 0 — consolidate continues notes[0], so the merged note inherits
  // its depositIndex/derivationVersion. For an open lineage this is what keeps the position claimable.
  if (slot0Deposit !== undefined) {
    const idx = picked.findIndex((n) => n.depositIndex === slot0Deposit)
    if (idx > 0) picked.unshift(picked.splice(idx, 1)[0]!)
  }

  return { ok: true, selection: { notes: picked, total } }
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

// ── One-off maintenance: hide a permanently-stranded open position ────────────
// A bet whose deposit lineage was fully withdrawn/consolidated away (pre-FC-16) can never be settled
// or closed — its payout has no note to land on — yet it is a real on-chain bet, so recovery and the
// reconcile self-heal keep rebuilding/re-showing its BET_RECEIPT. We suppress it at THIS single READ
// chokepoint (downstream of both), keyed by the public `nullifier_of_bet`, so it stops showing AND
// stops the background finalize polls (which iterate open receipts → the wasted proving / RAM).
// NOT a product feature: the set is empty by default and managed only via `hideReceipt()` / the
// dev-console helper below (`window.polyshield`).
const HIDDEN_RECEIPTS_KEY = 'polyshield:hidden_receipts'

function loadHiddenReceipts(): Set<string> {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return new Set()
  try {
    const raw = localStorage.getItem(HIDDEN_RECEIPTS_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]).map((s) => s.toLowerCase()) : [])
  } catch {
    return new Set()
  }
}

/** Hide ONE stranded open position locally, by its `nullifier_of_bet` (idempotent, reversible). The
 *  nullifier is already public on-chain, so this stores nothing sensitive. */
export function hideReceipt(nullifierOfBet: string): void {
  if (typeof window === 'undefined') return
  const set = loadHiddenReceipts()
  set.add(nullifierOfBet.toLowerCase())
  try { localStorage.setItem(HIDDEN_RECEIPTS_KEY, JSON.stringify([...set])) } catch { /* quota */ }
}

/** Un-hide a previously hidden position. */
export function unhideReceipt(nullifierOfBet: string): void {
  if (typeof window === 'undefined') return
  const set = loadHiddenReceipts()
  set.delete(nullifierOfBet.toLowerCase())
  try { localStorage.setItem(HIDDEN_RECEIPTS_KEY, JSON.stringify([...set])) } catch { /* quota */ }
}

export function getHiddenReceipts(): string[] {
  return [...loadHiddenReceipts()]
}

export function getOpenBetReceipts(wallet: `0x${string}`): Note[] {
  const hidden = loadHiddenReceipts()
  return loadAll().filter(
    (n) =>
      !n.spent &&
      n.kind === 'BET_RECEIPT' &&
      sameAddress(n.owner_address, wallet) &&
      !hidden.has((n.nullifier_of_bet ?? n.nullifier).toLowerCase()),
  )
}

// Dev-only console maintenance. Call once from a client effect (app/app/layout.tsx). NOT a product
// feature — no UI. Available in `next dev` (NODE_ENV !== 'production') or any build with
// NEXT_PUBLIC_DEV_MODE=true. Exposes `window.polyshield`:
//   polyshield.listOpenReceipts()            → every open BET_RECEIPT + whether its lineage still has a
//                                              spendable note (`hasFreeNote:false` ⇒ stranded) + hidden flag
//   polyshield.hideReceipt('0x<nullifier>')   → hide that one + reload
//   polyshield.unhideReceipt('0x<nullifier>') → undo + reload
export function installDevConsole(): void {
  if (typeof window === 'undefined') return
  // Reachable in `next dev`, in a NEXT_PUBLIC_DEV_MODE build, OR when explicitly opted in via
  // localStorage `ps_debug=1` + reload — so it can be enabled on a prod Docker build (NODE_ENV=
  // production, dev-mode off) for one-off maintenance, without changing env vars or rebuilding.
  const debugFlag = (() => { try { return localStorage.getItem('ps_debug') === '1' } catch { return false } })()
  if (process.env.NODE_ENV === 'production' && process.env.NEXT_PUBLIC_DEV_MODE !== 'true' && !debugFlag) return
  ;(window as unknown as { polyshield?: unknown }).polyshield = {
    listOpenReceipts: (wallet?: `0x${string}`) =>
      loadAll()
        .filter((n) => n.kind === 'BET_RECEIPT' && !n.spent && (!wallet || sameAddress(n.owner_address, wallet)))
        .map((n) => ({
          market: n.marketName ?? n.marketId,
          nullifier_of_bet: n.nullifier_of_bet ?? n.nullifier,
          depositIndex: n.depositIndex,
          hasFreeNote: !!getFreeNoteForDeposit(n.owner_address, n.depositIndex),
          hidden: loadHiddenReceipts().has((n.nullifier_of_bet ?? n.nullifier).toLowerCase()),
        })),
    hideReceipt: (n: string) => { hideReceipt(n); location.reload() },
    unhideReceipt: (n: string) => { unhideReceipt(n); location.reload() },
    getHiddenReceipts,
  }
}

export function clearNoteCache(): void {
  cachedNotes = null
  cachedActivity = null
  hydrated = false
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

/**
 * V1 (legacy) per-index secret. Signs once per index. Used for pre-FC-13 notes
 * (derivationVersion 1) and as the recovery fallback for legacy deposits.
 */
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

/** Alias for clarity at call sites that explicitly mean the V1 scheme. */
export const deriveSecretV1 = deriveSecret

/**
 * V2 (FC-13) master seed. ONE wallet signature; secretSession.ts caches the result for the
 * session, then derives every note secret from it locally via deriveSecretV2 (no further prompts).
 */
export async function deriveMasterSeed(
  signMessageAsync: (args: { message: string }) => Promise<`0x${string}`>,
  address: `0x${string}`,
): Promise<`0x${string}`> {
  const sig = await signMessageAsync({ message: masterSeedMessageV2(address) })
  return keccak256(toBytes(sig))
}

/**
 * Derive a note's V2 secret from the master seed + deposit index, entirely locally (no signature):
 * secret_i = keccak256(masterSeed ‖ uint32(index)) mod p. Distinct per index, deterministic.
 */
export function deriveSecretV2(masterSeed: `0x${string}`, index: number): `0x${string}` {
  const idxHex = (index >>> 0).toString(16).padStart(8, '0')
  const hash = keccak256(`0x${masterSeed.slice(2)}${idxHex}` as `0x${string}`)
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

/** Persist that `usedIndex` was consumed, so the local counter never hands it out again (sets it to
 *  at least usedIndex+1). Use after a confirmed deposit instead of a blind increment, since the used
 *  index may be higher than the local counter (it was derived from the on-chain deposit count). */
export function recordDepositIndexUsed(address: `0x${string}`, usedIndex: number): void {
  if (typeof window === 'undefined') return
  const key = INDEX_KEY_PREFIX + address.toLowerCase()
  const next = Math.max(getNextDepositIndex(address), usedIndex + 1)
  localStorage.setItem(key, next.toString())
}

/**
 * Collision-proof next deposit index. The localStorage counter alone is unsafe: if it's cleared it
 * resets to 0 and the next deposit re-derives an OLD index → the same secret → a note with a nullifier
 * that may already be spent, which LOCKS the deposit (a nonce-0 note has exactly one nullifier). So
 * take the max of the local counter and the wallet's on-chain deposit COUNT (from the backend index),
 * which is monotonic and survives a cache wipe. The deposit flow additionally verifies the derived
 * nullifier isn't already spent before committing (belt-and-suspenders).
 */
export async function getSafeNextDepositIndex(
  address: `0x${string}`,
  recoveryBase = '/api/recovery-data',
): Promise<number> {
  const local = getNextDepositIndex(address)
  try {
    const res = await fetch(`${recoveryBase}/${address}`, { cache: 'no-store' })
    if (res.ok) {
      const d = (await res.json()) as { deposits?: unknown[] }
      return Math.max(local, (d.deposits ?? []).length)
    }
  } catch {
    /* backend unavailable → fall back to the local counter */
  }
  return local
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
  createdAt: number // block timestamp of when this note state was produced
}

const depositedEvent = parseAbiItem(
  'event Deposited(address indexed depositor, bytes32 commitment, uint256 amount)',
)
const betAuthorizedEvent = parseAbiItem(
  // FC-14: protocolFee + relayFee recorded on-chain so recovery reconstructs the exact post-bet
  // balance regardless of governance rate changes (older bets lack these → legacy fallback below).
  'event BetAuthorized(bytes32 indexed nullifier, bytes32 market_id, bytes32 position_id, uint64 expected_shares, uint256 bet_amount, uint64 price, uint8 outcome_side, bytes32 new_commitment, uint64 protocolFee, uint64 relayFee)',
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
// FC-4/L3: partial-fill credit (refund of the unfilled remainder of a downsized market order or a
// partially-filled limit order). Same signature as the cancel events; the event carries no
// amount, so recovery derives the refund from the (post-normalization) on-chain betRecord.
const partialFillCreditedEvent = parseAbiItem(
  'event PartialFillCredited(bytes32 indexed nullifier, bytes32 nullifier_of_bet, bytes32 new_commitment)',
)
const withdrawnEvent = parseAbiItem(
  'event Withdrawn(bytes32 indexed nullifier, address recipient, uint256 amount, bytes32 new_commitment)',
)
// FC-1: position close events.
const betSoldEvent = parseAbiItem(
  'event BetSold(bytes32 indexed nullifier_of_bet, uint64 sold_shares, uint64 proceeds)',
)
const positionClosedEvent = parseAbiItem(
  'event PositionClosed(bytes32 indexed nullifier, bytes32 nullifier_of_bet, bytes32 new_commitment, bool fullClose)',
)
// FC-8: note consolidation. Carries all 4 input nullifiers (zeros for inactive slots)
// and the merged output commitment, so recovery can merge the spent lineages.
const consolidatedEvent = parseAbiItem(
  'event Consolidated(bytes32[4] nullifiers, bytes32 new_commitment)',
)
// FEE: governance fee config — recovery reads betFeeBps + relayGasFeeUSDC to reproduce the
// post-bet balance (new_balance = balance - bet_amount - fee). The fee is not in the
// BetAuthorized event, so it must be read from contract state.
const feeConfigFn = parseAbiItem(
  'function feeConfig() view returns (uint16 betFeeBps, uint64 relayGasFeeUSDC, uint64 minBet, uint64 withdrawalFeeUSDC, uint64 minWithdrawal, address feeRecipient)',
)

// Chronological comparator for on-chain logs: by blockNumber, then by logIndex
// within a block. Used both for the per-bet BetSold queue and for the merged
// recovery event timeline, so operator-reported proceeds pair to the matching
// PositionClosed even when several events land in the same block.
export function byBlockThenLogIndex(
  a: { blockNumber?: bigint | null; logIndex?: number | null },
  b: { blockNumber?: bigint | null; logIndex?: number | null },
): number {
  const ab = a.blockNumber ?? 0n
  const bb = b.blockNumber ?? 0n
  if (ab === bb) return (a.logIndex ?? 0) - (b.logIndex ?? 0)
  return Number(ab - bb)
}

/**
 * Reconstruct notes by scanning on-chain Vault events and replaying state per deposit index.
 */
/**
 * Fetch logs over [fromBlock, toBlock] in chunks via `fetchRange`, halving the window on any
 * range/result-limit error (public RPCs cap eth_getLogs at ~10000 blocks). Generic over the
 * log type so each caller keeps viem's inferred return type. Gives up only if a single-block
 * window still fails (a real RPC error, not a cap).
 */
async function getLogsPaged<T>(
  fetchRange: (from: bigint, to: bigint) => Promise<T[]>,
  fromBlock: bigint,
  toBlock: bigint,
  chunk = 9000n,
): Promise<T[]> {
  const out: T[] = []
  let from = fromBlock
  let span = chunk
  while (from <= toBlock) {
    const to = from + span - 1n > toBlock ? toBlock : from + span - 1n
    try {
      out.push(...(await fetchRange(from, to)))
      from = to + 1n
    } catch (err) {
      if (to === from) throw err
      span = span / 2n > 0n ? span / 2n : 1n
    }
  }
  return out
}

export async function recoverNotes(
  address: `0x${string}`,
  signMessageAsync: (args: { message: string }) => Promise<`0x${string}`>,
  vaultAddress: `0x${string}`,
  rpcUrl = process.env.NEXT_PUBLIC_CHAIN_RPC ?? 'http://127.0.0.1:8545',
  gapLimit = 5,
  onProgress?: (done: number, total: number) => void,
  getMasterSeed?: (
    sign: (args: { message: string }) => Promise<`0x${string}`>,
    address: `0x${string}`,
  ) => Promise<`0x${string}`>,
): Promise<Note[]> {
  const client = createPublicClient({ transport: http(rpcUrl) })
  // Start the log scan at the vault's deploy block, not genesis. A public Polygon RPC
  // (e.g. publicnode) rejects a fromBlock:0→latest getLogs over ~88M blocks ("could not
  // coalesce error"), which made recovery throw and the portfolio render empty.
  const fromBlock = BigInt(process.env.NEXT_PUBLIC_VAULT_DEPLOY_BLOCK ?? '0')
  return recoverNotesWithClient(address, signMessageAsync, client, vaultAddress, gapLimit, 1000, fromBlock, onProgress, getMasterSeed)
}

// Fields that arrive from /recovery-data as decimal strings and must be bigints for the replay.
const RECOVERY_BIGINT_FIELDS: Record<string, string[]> = {
  Deposited: ['amount'],
  BetAuthorized: ['expected_shares', 'bet_amount', 'price', 'protocolFee', 'relayFee'],
  Withdrawn: ['amount'],
  BetSold: ['sold_shares', 'proceeds'],
}

type BackendEvent = { type: string; blockNumber: number; logIndex: number; txHash: string; args: Record<string, unknown> }

function mapBackendEvent(e: BackendEvent) {
  const args: Record<string, unknown> = { ...e.args }
  for (const f of RECOVERY_BIGINT_FIELDS[e.type] ?? []) if (args[f] != null) args[f] = BigInt(args[f] as string)
  if (e.type === 'BetAuthorized' && args.outcome_side != null) args.outcome_side = Number(args.outcome_side)
  return { _name: e.type, args, blockNumber: BigInt(e.blockNumber), transactionHash: e.txHash as `0x${string}`, logIndex: e.logIndex }
}

/**
 * Recover notes by fetching PUBLIC event data from the BACKEND (/recovery-data) instead of scanning
 * the chain through the user's RPC (slow + Alchemy-free's 10-block getLogs cap). Privacy-preserving:
 * the backend serves only public events; the secret-based matching runs HERE (client-side) via the
 * SAME replay (recoverNotesWithClient) fed through a shim client. Only the heavy getLogs are served
 * from the backend; the few cheap state reads (pendingCredit / betRecords / feeConfig) still go to
 * the real RPC. A malicious backend can at worst cause INCOMPLETE recovery (omitting events) — it
 * cannot forge notes, since the replay only acts on events whose nullifier matches the wallet's own
 * derived nullifier.
 */
export async function recoverNotesViaBackend(
  address: `0x${string}`,
  signMessageAsync: (args: { message: string }) => Promise<`0x${string}`>,
  vaultAddress: `0x${string}`,
  rpcUrl = process.env.NEXT_PUBLIC_CHAIN_RPC ?? 'http://127.0.0.1:8545',
  recoveryBase = '/api/recovery-data',
  gapLimit = 5,
  onProgress?: (done: number, total: number) => void,
  getMasterSeed?: (
    sign: (args: { message: string }) => Promise<`0x${string}`>,
    address: `0x${string}`,
  ) => Promise<`0x${string}`>,
): Promise<Note[]> {
  const res = await fetch(`${recoveryBase}/${address}`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`recovery-data HTTP ${res.status}`)
  const data = (await res.json()) as { deposits: BackendEvent[]; spends: BackendEvent[]; blockTimestamps: Record<string, number> }
  const all = [...(data.deposits ?? []), ...(data.spends ?? [])].map(mapBackendEvent)
  const real = createPublicClient({ transport: http(rpcUrl) })

  // Shim: serve getLogs from the backend events (filtered by event name + block range so the replay's
  // paging reassembles them once); getBlock timestamps from the payload; delegate the rest to the RPC.
  const shim = {
    getBlockNumber: () => real.getBlockNumber(),
    readContract: (p: unknown) => real.readContract(p as never),
    getLogs: async (p: { event?: { name?: string }; fromBlock?: bigint; toBlock?: bigint }) => {
      const name = p?.event?.name
      let evs = all.filter((e) => e._name === name)
      if (p?.fromBlock != null) evs = evs.filter((e) => e.blockNumber >= p.fromBlock!)
      if (p?.toBlock != null) evs = evs.filter((e) => e.blockNumber <= p.toBlock!)
      return evs
    },
    getBlock: async (p: { blockNumber?: bigint }) => {
      const ts = p?.blockNumber != null ? data.blockTimestamps?.[String(Number(p.blockNumber))] : undefined
      if (ts != null) return { timestamp: BigInt(ts) }
      return real.getBlock(p as Parameters<typeof real.getBlock>[0])
    },
  } as unknown as PublicClient

  const fromBlock = BigInt(process.env.NEXT_PUBLIC_VAULT_DEPLOY_BLOCK ?? '0')
  return recoverNotesWithClient(address, signMessageAsync, shim, vaultAddress, gapLimit, 1000, fromBlock, onProgress, getMasterSeed)
}

export async function recoverNotesWithClient(
  address: `0x${string}`,
  signMessageAsync: (args: { message: string }) => Promise<`0x${string}`>,
  client: PublicClient,
  vaultAddress: `0x${string}`,
  // FC-5 gap 2: stop after this many CONSECUTIVE deposit indices with no matching
  // deposit, rather than a fixed cap. `hardCap` bounds the scan defensively.
  gapLimit = 5,
  hardCap = 1000,
  fromBlock: bigint = 0n,
  // FC-13: determinate progress callback (done, total) for the recovery UI.
  onProgress?: (done: number, total: number) => void,
  // FC-13: resolve the V2 master seed, reusing a seed already unlocked this session (so recovery
  // adds ZERO signatures when the user is already unlocked). Omitted → recovery derives it itself.
  getMasterSeed?: (
    sign: (args: { message: string }) => Promise<`0x${string}`>,
    address: `0x${string}`,
  ) => Promise<`0x${string}`>,
): Promise<Note[]> {
  // Public Polygon RPCs (e.g. publicnode) cap eth_getLogs at 10000 blocks, so page each scan
  // in <=9000-block windows (auto-halving on any range/result-limit error). A single
  // fromBlock→latest scan once the vault has >10k blocks of history is rejected outright.
  const toBlock = await client.getBlockNumber()
  const paged = <T>(fetchRange: (from: bigint, to: bigint) => Promise<T[]>): Promise<T[]> =>
    getLogsPaged(fetchRange, fromBlock, toBlock)

  const [deposits, bets, settlements, betCancels, naCancels, partials, withdrawals, betSolds, positionCloseds, consolidations] =
    await Promise.all([
      paged((f, t) => client.getLogs({ address: vaultAddress, event: depositedEvent, args: { depositor: address }, fromBlock: f, toBlock: t })),
      paged((f, t) => client.getLogs({ address: vaultAddress, event: betAuthorizedEvent, fromBlock: f, toBlock: t })),
      paged((f, t) => client.getLogs({ address: vaultAddress, event: settlementCreditedEvent, fromBlock: f, toBlock: t })),
      paged((f, t) => client.getLogs({ address: vaultAddress, event: betCancelEvent, fromBlock: f, toBlock: t })),
      paged((f, t) => client.getLogs({ address: vaultAddress, event: naCancelEvent, fromBlock: f, toBlock: t })),
      paged((f, t) => client.getLogs({ address: vaultAddress, event: partialFillCreditedEvent, fromBlock: f, toBlock: t })),
      paged((f, t) => client.getLogs({ address: vaultAddress, event: withdrawnEvent, fromBlock: f, toBlock: t })),
      paged((f, t) => client.getLogs({ address: vaultAddress, event: betSoldEvent, fromBlock: f, toBlock: t })),
      paged((f, t) => client.getLogs({ address: vaultAddress, event: positionClosedEvent, fromBlock: f, toBlock: t })),
      paged((f, t) => client.getLogs({ address: vaultAddress, event: consolidatedEvent, fromBlock: f, toBlock: t })),
    ])

  // FEE: read the current governance fee once so the replay reproduces each post-bet balance
  // (new_balance = balance - bet_amount - fee). Bets placed before the fee was enabled are
  // handled per-bet via a commitment check below, so a later rate change does not corrupt them.
  let betFeeBps = 0n
  let relayGasFeeUSDC = 0n
  try {
    const fc = (await client.readContract({
      address: vaultAddress,
      abi: [feeConfigFn],
      functionName: 'feeConfig',
    })) as readonly [number, bigint, bigint, bigint, bigint, `0x${string}`]
    betFeeBps = BigInt(fc[0])
    relayGasFeeUSDC = BigInt(fc[1])
  } catch {
    /* older Vault without feeConfig → treat fee as 0 */
  }

  // FC-5 gap 4: real timestamps. Prefetch the block timestamp for every referenced
  // block once, so recovered notes/activity carry true on-chain times (not Date.now()).
  const blockNums = new Set<bigint>()
  for (const e of [...deposits, ...bets, ...settlements, ...betCancels, ...naCancels, ...partials, ...withdrawals, ...positionCloseds, ...consolidations]) {
    if (e.blockNumber != null) blockNums.add(e.blockNumber)
  }
  const tsByBlock = new Map<bigint, number>()
  await Promise.all([...blockNums].map(async (bn) => {
    try {
      const blk = await client.getBlock({ blockNumber: bn })
      tsByBlock.set(bn, Number(blk.timestamp) * 1000)
    } catch {
      /* leave unset → falls back to Date.now() below */
    }
  }))
  const tsOf = (bn?: bigint): number => (bn != null ? tsByBlock.get(bn) ?? Date.now() : Date.now())

  // FC-8: consolidate merges several lineages into one, so a single replay in
  // deposit-index order can't know the merged balance (a contributor may have a
  // higher index than slot 0). We replay twice: a DISCOVERY pass records each
  // consolidate input's balance into balanceByNullifier (treating consolidate as a
  // terminal spend), then a FINAL pass emits notes and resolves slot-0 sums from the
  // now-complete map. Secrets are derived once (cached) so the wallet is prompted once
  // per index. Nested consolidations (a merged note re-consolidated) are not tracked
  // by the discovery pass and would under-count; that is an accepted v1 limitation.
  const ZERO_NULL = `0x${'00'.repeat(32)}`.toLowerCase()
  const balanceByNullifier = new Map<string, bigint>()

  const buildSoldByBet = (): Map<string, Array<{ proceeds: bigint; soldShares: bigint }>> => {
    // FC-1: queue of operator-reported sale proceeds per bet, consumed in block order
    // by each PositionClosed (handles repeated partial closes against the same bet).
    const m = new Map<string, Array<{ proceeds: bigint; soldShares: bigint }>>()
    for (const s of [...betSolds].sort(byBlockThenLogIndex)) {
      const k = (s.args.nullifier_of_bet as string).toLowerCase()
      const arr = m.get(k) ?? []
      arr.push({ proceeds: s.args.proceeds as bigint, soldShares: s.args.sold_shares as bigint })
      m.set(k, arr)
    }
    return m
  }

  type ReplayOut = {
    recovered: Note[]
    activity: WalletActivityEvent[]
    soldByBet: Map<string, Array<{ proceeds: bigint; soldShares: bigint }>>
  }

  const replayLineage = async (
    index: number,
    secret: `0x${string}`,
    deposit: (typeof deposits)[number],
    mode: 'discover' | 'final',
    out: ReplayOut,
    version: 1 | 2,
  ): Promise<void> => {
    const { recovered, activity, soldByBet } = out
    const receiptByBetNullifier = new Map<string, Note>()

    const depositTs = tsOf(deposit.blockNumber ?? undefined)
    activity.push({
      id: `deposit-${deposit.transactionHash}-${index}`,
      wallet: address,
      kind: 'deposit',
      amount: deposit.args.amount!,
      createdAt: depositTs,
      txHash: deposit.transactionHash,
    })

    let state: ChainNoteState = {
      secret,
      depositIndex: index,
      balance: deposit.args.amount!,
      nonce: 0n,
      commitment: deposit.args.commitment! as `0x${string}`,
      nullifier: computeNullifier(secret, 0n),
      kind: 'DEPOSIT',
      spent: false,
      createdAt: depositTs,
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
        createdAt: s.createdAt,
        txHash,
        derivationVersion: version,
      })
    }

    const events = [
      ...bets.map((e) => ({ type: 'bet' as const, block: e.blockNumber!, idx: e.logIndex, tx: e.transactionHash, args: e.args })),
      ...settlements.map((e) => ({ type: 'settle' as const, block: e.blockNumber!, idx: e.logIndex, tx: e.transactionHash, args: e.args })),
      ...betCancels.map((e) => ({ type: 'betCancel' as const, block: e.blockNumber!, idx: e.logIndex, tx: e.transactionHash, args: e.args })),
      ...naCancels.map((e) => ({ type: 'naCancel' as const, block: e.blockNumber!, idx: e.logIndex, tx: e.transactionHash, args: e.args })),
      ...partials.map((e) => ({ type: 'partial' as const, block: e.blockNumber!, idx: e.logIndex, tx: e.transactionHash, args: e.args })),
      ...positionCloseds.map((e) => ({ type: 'close' as const, block: e.blockNumber!, idx: e.logIndex, tx: e.transactionHash, args: e.args })),
      ...consolidations.map((e) => ({ type: 'consolidate' as const, block: e.blockNumber!, idx: e.logIndex, tx: e.transactionHash, args: e.args })),
      ...withdrawals
        .filter((e) => sameAddress(e.args.recipient!, address))
        .map((e) => ({ type: 'withdraw' as const, block: e.blockNumber!, idx: e.logIndex, tx: e.transactionHash, args: e.args })),
    ].sort((a, b) => {
      // Match the per-bet BetSold queue ordering (block, then logIndex) so each
      // PositionClosed consumes the proceeds reported for it; tx hash is a final tiebreak.
      if (a.block !== b.block) return Number(a.block - b.block)
      if ((a.idx ?? 0) !== (b.idx ?? 0)) return (a.idx ?? 0) - (b.idx ?? 0)
      return (a.tx ?? '').localeCompare(b.tx ?? '')
    })

    for (const ev of events) {
      const evTs = tsOf(ev.block)
      if (ev.type === 'bet') {
        const betNull = ev.args.nullifier! as `0x${string}`
        if (betNull.toLowerCase() !== state.nullifier.toLowerCase() || state.spent) continue

        const betAmount = ev.args.bet_amount!
        const newNonce = state.nonce + 1n
        const newCommitment = ev.args.new_commitment! as `0x${string}`
        // FC-14: the exact fee split is in the event → reconstruct the post-bet balance exactly
        // (no governance-rate-change corruption). Legacy bets predating FC-14 lack these fields
        // (undefined) → fall back to recompute-from-current-config + a commitment-trial that drops
        // the fee for pre-fee bets.
        const eventProtocolFee = ev.args.protocolFee as bigint | undefined
        const eventRelayFee = ev.args.relayFee as bigint | undefined
        let newBalance: bigint
        if (eventProtocolFee != null) {
          newBalance = state.balance - betAmount - eventProtocolFee - (eventRelayFee ?? 0n)
        } else {
          const fee = (betAmount * betFeeBps) / 10_000n + relayGasFeeUSDC
          newBalance = state.balance - betAmount - fee
          if (
            fee > 0n &&
            computeCommitment(secret, newBalance, newNonce, address).toLowerCase() !==
              newCommitment.toLowerCase()
          ) {
            newBalance = state.balance - betAmount
          }
        }

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
          position_id: ev.args.position_id as `0x${string}` | undefined,
          condition_id: ev.args.market_id! as `0x${string}`,
          marketId: ev.args.market_id as string | undefined,
          bet_amount: betAmount,
          expectedShares: ev.args.expected_shares,
          spent: false,
          createdAt: evTs,
          txHash: ev.tx,
          derivationVersion: version,
          protocolFee: eventProtocolFee, // FC-14: original protocol fee, for cancel/partial refund replay
        }
        recovered.push(receipt)
        receiptByBetNullifier.set(betNull.toLowerCase(), receipt)
        activity.push({
          id: `bet-${ev.tx}-${betNull}`,
          wallet: address,
          kind: 'bet',
          amount: betAmount,
          createdAt: evTs,
          txHash: ev.tx,
          marketId: ev.args.market_id as `0x${string}` | undefined,
          receiptId,
          receiptNullifier: betNull,
        })

        state = {
          secret,
          depositIndex: index,
          balance: newBalance,
          nonce: newNonce,
          commitment: newCommitment,
          nullifier: computeNullifier(secret, newNonce),
          kind: 'BET_OUTPUT',
          spent: false,
          createdAt: evTs,
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
          // FC-14: a full bet cancellation refunds the protocol fee in addition to the stake;
          // an N/A (void) cancellation keeps the fee (the bet executed). Mirrors the contract.
          const protocolRefund = ev.type === 'betCancel' ? (receipt.protocolFee ?? 0n) : 0n
          newBalance = oldBalance + receipt.bet_amount + protocolRefund
        } else {
          newBalance = inferBalanceFromCommitment(secret, newNonce, address, newCommitment) ?? oldBalance
        }

        const credited = newBalance - oldBalance
        activity.push({
          id: `${ev.type}-${ev.tx}-${betNull}`,
          wallet: address,
          kind: ev.type === 'settle' ? 'settlement' : 'refund',
          amount: credited,
          createdAt: evTs,
          txHash: ev.tx,
          marketId: receipt?.marketId as `0x${string}` | undefined,
          receiptId: receipt?.id,
          receiptNullifier: betNull as `0x${string}`,
          payout: credited,
        })

        state = {
          secret,
          depositIndex: index,
          balance: newBalance,
          nonce: newNonce,
          commitment: newCommitment,
          nullifier: computeNullifier(secret, newNonce),
          kind: ev.type === 'settle' ? 'SETTLE_CREDIT' : 'CANCEL_CREDIT',
          spent: false,
          createdAt: evTs,
        }
      } else if (ev.type === 'partial') {
        // FC-4/L3: partial-fill credit. Spends the current free note and credits the unfilled
        // remainder. The event carries no amount, but after partialFillCredit the on-chain record
        // is NORMALIZED (expected_shares := filled, bet_amount := spent), so we read it back and
        // derive refund = committed bet (the BetAuthorized amount on the receipt) − spent. Chain-
        // only — no off-chain attestation. The receipt is normalized but stays OPEN (the filled
        // position settles/closes later); it is NOT marked spent.
        const spentNull = ev.args.nullifier! as `0x${string}`
        if (spentNull.toLowerCase() !== state.nullifier.toLowerCase() || state.spent) continue

        const betNull = ev.args.nullifier_of_bet! as string
        const receipt = receiptByBetNullifier.get(betNull.toLowerCase())

        let normFilled: bigint | undefined
        let normSpent: bigint | undefined
        try {
          // betRecords getter tuple: [market_id, condition_id, position_id, expected_shares(3),
          // bet_amount(4), outcome_side, status, sell_proceeds, sold_shares, filled_shares, spent_amount].
          const rec = (await client.readContract({
            address: vaultAddress,
            abi: [{
              type: 'function', name: 'betRecords', stateMutability: 'view',
              inputs: [{ type: 'bytes32' }],
              outputs: [
                { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' },
                { type: 'uint64' }, { type: 'uint64' }, { type: 'uint8' }, { type: 'uint8' },
                { type: 'uint64' }, { type: 'uint64' }, { type: 'uint64' }, { type: 'uint64' },
              ],
            }],
            functionName: 'betRecords',
            args: [betNull as `0x${string}`],
          })) as readonly unknown[]
          normFilled = BigInt(rec[3] as bigint)
          normSpent = BigInt(rec[4] as bigint)
        } catch {
          /* leave undefined → fall back to commitment inference below */
        }

        const committed = receipt?.bet_amount ?? 0n
        const oldBalance = state.balance
        state.spent = true
        pushFree(state, ev.tx)

        const newNonce = state.nonce + 1n
        const newCommitment = ev.args.new_commitment! as `0x${string}`
        // FC-14: refund = unfilled stake + pro-rata protocol fee on the unexecuted portion
        // (relay fee kept). Mirrors the contract's floor math using the ORIGINAL committed amount
        // and the original protocol fee (both captured before the receipt is normalized below).
        let refund = 0n
        if (normSpent != null && committed > normSpent) {
          const unexec = committed - normSpent
          const protocolRefund = committed > 0n ? ((receipt?.protocolFee ?? 0n) * unexec) / committed : 0n
          refund = unexec + protocolRefund
        }
        let newBalance = oldBalance + refund
        if (normSpent == null) {
          // betRecords unreadable — back the refund out of the on-chain commitment if possible.
          const inferred = inferBalanceFromCommitment(secret, newNonce, address, newCommitment)
          if (inferred != null) {
            newBalance = inferred
            refund = inferred > oldBalance ? inferred - oldBalance : 0n
          }
        }

        // Normalize the receipt to the actual fill — it stays OPEN for later settle/close.
        if (receipt) {
          if (normFilled != null) receipt.expectedShares = normFilled
          if (normSpent != null) receipt.bet_amount = normSpent
        }

        // FC-14: only a genuine partial (real unfilled remainder) is a capital return worth showing;
        // a fee-only short fill refunds 0 and must not clutter the feed (matches finalizePartialFill).
        if (refund > 0n) {
          activity.push({
            id: `partial-${ev.tx}-${betNull}`,
            wallet: address,
            kind: 'refund',
            amount: refund,
            createdAt: evTs,
            txHash: ev.tx,
            marketId: receipt?.marketId as `0x${string}` | undefined,
            receiptId: receipt?.id,
            receiptNullifier: betNull as `0x${string}`,
            payout: refund,
          })
        }

        state = {
          secret,
          depositIndex: index,
          balance: newBalance,
          nonce: newNonce,
          commitment: newCommitment,
          nullifier: computeNullifier(secret, newNonce),
          kind: 'CANCEL_CREDIT',
          spent: false,
          createdAt: evTs,
        }
      } else if (ev.type === 'close') {
        // FC-1: position close credit. proceeds come from the matching BetSold report.
        const spentNull = ev.args.nullifier! as `0x${string}`
        if (spentNull.toLowerCase() !== state.nullifier.toLowerCase() || state.spent) continue

        const betNull = ev.args.nullifier_of_bet! as string
        const fullClose = ev.args.fullClose as boolean
        const sale = soldByBet.get(betNull.toLowerCase())?.shift()
        const proceeds = sale?.proceeds ?? 0n

        const receipt = receiptByBetNullifier.get(betNull.toLowerCase())
        if (receipt) {
          if (fullClose) {
            receipt.spent = true
          } else if (sale?.soldShares != null && receipt.expectedShares != null) {
            receipt.expectedShares = receipt.expectedShares - sale.soldShares
          }
        }

        const oldBalance = state.balance
        state.spent = true
        pushFree(state, ev.tx)

        const newNonce = state.nonce + 1n
        const newCommitment = ev.args.new_commitment! as `0x${string}`
        const newBalance = oldBalance + proceeds

        activity.push({
          id: `close-${ev.tx}-${betNull}`,
          wallet: address,
          kind: 'settlement',
          amount: proceeds,
          createdAt: evTs,
          txHash: ev.tx,
          marketId: receipt?.marketId as `0x${string}` | undefined,
          receiptId: receipt?.id,
          receiptNullifier: betNull as `0x${string}`,
          payout: proceeds,
        })

        state = {
          secret,
          depositIndex: index,
          balance: newBalance,
          nonce: newNonce,
          commitment: newCommitment,
          nullifier: computeNullifier(secret, newNonce),
          kind: 'SETTLE_CREDIT',
          spent: false,
          createdAt: evTs,
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

        activity.push({
          id: `withdrawal-${ev.tx}`,
          wallet: address,
          kind: 'withdrawal',
          amount: withdrawalAmount,
          createdAt: evTs,
          txHash: ev.tx,
        })

        if (!hasRemainder) {
          state = { ...state, balance: 0n, spent: true }
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
          createdAt: evTs,
        }
      } else if (ev.type === 'consolidate') {
        // FC-8: this lineage's current note is one of the (up to 4) consolidate inputs.
        const nl = (ev.args.nullifiers as readonly string[]).map((n) => n.toLowerCase())
        const cur = state.nullifier.toLowerCase()
        if (!nl.includes(cur) || state.spent) continue

        // Record this input's balance so a slot-0 lineage can sum the merged note.
        balanceByNullifier.set(cur, state.balance)
        state.spent = true
        pushFree(state, ev.tx)

        const slot0 = nl[0]
        if (cur !== slot0 || mode === 'discover') {
          // Contributor (non-slot-0), or discovery pass: lineage ends here. The merged
          // note is materialized by slot 0's lineage in the final pass.
          state = { ...state, spent: true }
          continue
        }

        // Slot 0, final pass: continue the lineage with the merged balance.
        let sum = 0n
        for (const n of nl) {
          if (n === ZERO_NULL) continue
          sum += balanceByNullifier.get(n) ?? 0n
        }
        const mergedNonce = state.nonce + 1n
        const mergedCommitment = ev.args.new_commitment as `0x${string}`
        state = {
          secret,
          depositIndex: index,
          balance: sum,
          nonce: mergedNonce,
          commitment: mergedCommitment,
          nullifier: computeNullifier(secret, mergedNonce),
          kind: 'BET_OUTPUT',
          spent: false,
          createdAt: evTs,
        }
      }
    }

    if (!state.spent && state.balance > 0n) {
      pushFree(state, undefined)
    }
  }

  // FC-13: map each on-chain Deposited commitment to its deposit index + secret.
  //  - V2 pass: derive the master seed ONCE (reusing the session seed when available), then derive
  //    each index's secret locally for free — so an all-V2 wallet recovers with ONE signature.
  //  - V1 fallback: only for commitments V2 can't match (legacy pre-FC-13 deposits); signs per
  //    scanned index. For an all-V2 wallet this loop never runs.
  // `deposits` is already filtered to THIS wallet, so deposits.length is the exact target count.
  const depositByIndex = new Map<number, (typeof deposits)[number]>()
  const secretByIndex = new Map<number, `0x${string}`>()
  const versionByIndex = new Map<number, 1 | 2>()
  const matched = new Set<string>()
  const total = deposits.length
  const report = () => onProgress?.(matched.size, total)
  const findDeposit = (secret: `0x${string}`) =>
    deposits.find(
      (d) =>
        !matched.has(d.args.commitment!.toLowerCase()) &&
        computeCommitment(secret, d.args.amount!, 0n, address).toLowerCase() ===
          d.args.commitment!.toLowerCase(),
    )

  report()
  // V2 pass — free after the single seed signature.
  let seed: `0x${string}` | null = null
  try {
    seed = getMasterSeed
      ? await getMasterSeed(signMessageAsync, address)
      : await deriveMasterSeed(signMessageAsync, address)
  } catch {
    seed = null // user rejected the seed signature → rely on the V1 fallback below
  }
  if (seed) {
    let consecutiveEmpty = 0
    for (let index = 0; index < hardCap && matched.size < total && consecutiveEmpty < gapLimit; index++) {
      const secret = deriveSecretV2(seed, index)
      const deposit = findDeposit(secret)
      if (!deposit) { consecutiveEmpty++; continue }
      consecutiveEmpty = 0
      depositByIndex.set(index, deposit)
      secretByIndex.set(index, secret)
      versionByIndex.set(index, 2)
      matched.add(deposit.args.commitment!.toLowerCase())
      report()
    }
  }

  // V1 fallback — legacy deposits only (signs per scanned index).
  if (matched.size < total) {
    let consecutiveEmpty = 0
    for (let index = 0; index < hardCap && matched.size < total && consecutiveEmpty < gapLimit; index++) {
      if (depositByIndex.has(index)) continue // already claimed by the V2 pass
      const secret = await deriveSecret(signMessageAsync, address, index)
      const deposit = findDeposit(secret)
      if (!deposit) { consecutiveEmpty++; continue }
      consecutiveEmpty = 0
      depositByIndex.set(index, deposit)
      secretByIndex.set(index, secret)
      versionByIndex.set(index, 1)
      matched.add(deposit.args.commitment!.toLowerCase())
      report()
    }
  }
  const indices = [...depositByIndex.keys()].sort((a, b) => a - b)

  // Pass 1 (discovery): populate balanceByNullifier with consolidate input balances.
  // Output is discarded; the only durable side effect is the balance map.
  const discardR: Note[] = []
  const discardA: WalletActivityEvent[] = []
  const discardSold = buildSoldByBet()
  for (const index of indices) {
    await replayLineage(
      index, secretByIndex.get(index)!, depositByIndex.get(index)!, 'discover',
      { recovered: discardR, activity: discardA, soldByBet: discardSold },
      versionByIndex.get(index)!,
    )
  }

  // Pass 2 (final): emit notes + activity, resolving consolidate slot-0 sums.
  const recovered: Note[] = []
  // FC-5 gap 1: rebuild the activity log from chain so realized P&L / history survive a wipe.
  const activity: WalletActivityEvent[] = []
  const finalSold = buildSoldByBet()
  for (const index of indices) {
    await replayLineage(
      index, secretByIndex.get(index)!, depositByIndex.get(index)!, 'final',
      { recovered, activity, soldByBet: finalSold },
      versionByIndex.get(index)!,
    )
  }

  saveAll(recovered)
  // FC-5 gap 1: replace this wallet's activity with the chain-derived log; keep other wallets'.
  const otherWallets = loadActivity().filter((e) => !sameAddress(e.wallet, address))
  saveActivity([...otherWallets, ...activity])
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

/**
 * Make spent-status CHAIN-AUTHORITATIVE. The local `spent` flag is best-effort and can lag a relayed
 * spend or a page reload, which makes note selection pick an already-spent note → the relay reverts
 * NullifierSpent and the user is forced to "Restore". This reconciles every locally-unspent note's
 * nullifier against the on-chain NullifierRegistry and marks the spent ones, so selection self-heals
 * on each portfolio load and right before each spend — the user never has to think about notes.
 * Never marks a note spent on a transient RPC error (would hide funds). Returns true if anything changed.
 */
const _receiptsHealedThisSession = new Set<string>()

export async function reconcileSpentStatus(wallet: `0x${string}`): Promise<boolean> {
  const vaultAddress = process.env.NEXT_PUBLIC_VAULT_ADDRESS as `0x${string}` | undefined
  if (!vaultAddress) return false
  const isNonZero = (h?: string): boolean => {
    if (!h) return false
    try {
      return BigInt(h) !== 0n
    } catch {
      return false
    }
  }
  // Only the SPENDABLE cash notes get the nullifier-spent check. A BET_RECEIPT tracking note
  // intentionally carries the nullifier of the cash note consumed at bet-auth (which IS spent
  // on-chain), so checking it would wrongly mark the OPEN bet "spent" and hide it. Match getSpendableNotes.
  const spendable = (n: Note): boolean => n.kind !== 'BET_RECEIPT'
  const notes = loadAll()
  let changed = false

  // (1) Mark spendable cash notes spent if their nullifier is spent on-chain (every call; cheap).
  const candidates = notes.filter(
    (n) => !n.spent && spendable(n) && sameAddress(n.owner_address, wallet) && isNonZero(n.nullifier),
  )
  if (candidates.length > 0) {
    const spentSet = await fetchSpentNullifiers(vaultAddress, candidates.map((n) => n.nullifier))
    if (spentSet.size > 0) {
      for (const note of notes) {
        if (!note.spent && spendable(note) && note.nullifier && spentSet.has(note.nullifier.toLowerCase())) {
          note.spent = true
          changed = true
        }
      }
    }
  }

  // (2) Self-heal BET_RECEIPT visibility, ONCE per session: an earlier bug could mark an OPEN bet's
  //     receipt spent (its nullifier == the spent cash note's). Un-mark any receipt whose on-chain
  //     bet status is still non-terminal (open/actionable), so open bets reappear without a Restore.
  const key = wallet.toLowerCase()
  if (!_receiptsHealedThisSession.has(key)) {
    _receiptsHealedThisSession.add(key)
    const TERMINAL = new Set<number>([BET_STATUS.CREDITED, BET_STATUS.CANCELLED_CREDITED, BET_STATUS.CLOSED_CREDITED])
    const hidden = notes.filter(
      (n) => n.spent && n.kind === 'BET_RECEIPT' && sameAddress(n.owner_address, wallet) && isNonZero(n.nullifier_of_bet),
    )
    for (const r of hidden) {
      try {
        const status = await fetchBetStatus(vaultAddress, r.nullifier_of_bet!)
        if (status >= 0 && !TERMINAL.has(status)) {
          r.spent = false
          changed = true
        }
      } catch {
        /* leave as-is on a read failure */
      }
    }
  }

  if (changed) {
    saveAll(notes)
    notifyNotesChanged()
  }
  return changed
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
 * Chain fingerprint = hash of the genesis block (block 0). Anvil seeds the genesis
 * timestamp from the wall clock on every `dev:mock` restart, so this value is unique
 * per chain instance. Comparing it on load detects a reset reliably even when the new
 * chain's block height already exceeds the previous session's last-seen block (the case
 * the block-number-decrease heuristic alone misses). Survives resetAllLocalState — it is
 * chain identity, not protocol state, and is overwritten with the new value right after a
 * reset is handled.
 */
export function getChainFingerprint(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(CHAIN_FP_KEY)
}

export function setChainFingerprint(fp: string): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(CHAIN_FP_KEY, fp)
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
  // Clear the in-memory caches and force a fresh hydrate next time.
  cachedNotes = null
  cachedActivity = null
  hydrated = false
  // FC-13: wipe the ENCRYPTED note/activity store in IndexedDB (best-effort; keeps the crypto key
  // so a subsequent fresh deposit re-encrypts under it). Legacy plaintext copies, if any, too.
  void removeEncrypted(STORAGE_KEY)
  void removeEncrypted(ACTIVITY_STORAGE_KEY)
  localStorage.removeItem(STORAGE_KEY)
  localStorage.removeItem(ACTIVITY_STORAGE_KEY)
  localStorage.removeItem(LAST_BLOCK_KEY)
  // Clear all deposit-index counters (may be one per wallet address) and pending-close markers
  // (per-wallet; pseudonymous) so a shared device doesn't leak either to the next connector.
  const toRemove: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (
      key?.startsWith(INDEX_KEY_PREFIX) ||
      key?.startsWith(CLOSE_MARKER_KEY_PREFIX) ||
      key?.startsWith(WITHDRAW_MARKER_KEY_PREFIX) ||
      key?.startsWith(DEPOSIT_MARKER_KEY_PREFIX)
    )
      toRemove.push(key)
  }
  toRemove.forEach((k) => localStorage.removeItem(k))
}

/**
 * Clear the WALLET CONNECTOR's persisted state (wagmi + WalletConnect/ConnectKit), separate from our
 * own note cache. On a hard refresh wagmi restores the last connector from this storage; if that
 * connector is broken (e.g. a WalletConnect session with an invalid project id), the restore hangs in
 * a half-connected state — the connect gate persists and "Disconnect" just reopens the connect modal.
 * Wiping it forces a clean slate so the next connect starts fresh. Caller should reload afterwards.
 */
export function resetWalletConnectorStorage(): void {
  if (typeof window === 'undefined') return
  const kill = (k: string) =>
    k.startsWith('wagmi') ||
    k.startsWith('wc@2') ||
    k.startsWith('@w3m') ||
    k.startsWith('@appkit') ||
    k.startsWith('-walletlink') ||
    k.toLowerCase().includes('walletconnect')
  const toRemove: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key && kill(key)) toRemove.push(key)
  }
  toRemove.forEach((k) => localStorage.removeItem(k))
  try { indexedDB.deleteDatabase('WALLET_CONNECT_V2_INDEXED_DB') } catch { /* best-effort */ }
}
