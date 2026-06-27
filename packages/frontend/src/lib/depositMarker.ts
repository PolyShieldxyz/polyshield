/**
 * Persisted pending-deposit markers.
 *
 * A deposit derives a note locally (secret in memory only), generates a 30s–2min ZK binding proof,
 * approves USDC, submits the deposit tx, then — only in the depositConfirmed effect — persists the
 * note (addNote) and records the deposit index used. The USDC has ALREADY left the wallet by the time
 * the tx is submitted, but nothing is persisted until confirmation lands. If the tab is closed / the
 * wallet flaps / the user switches accounts BETWEEN submit and the local note-cache update, the
 * just-derived note is gone — silent fund loss (C3).
 *
 * To leave a breadcrumb, we record a lightweight recovery marker JUST BEFORE the on-chain deposit
 * submit: the commitment, the deposit index, and the amount. On next mount the deposit page surfaces a
 * one-line, non-alarming hint pointing at Restore (which re-derives every Deposited(W,…) commitment by
 * index and replays on-chain events authoritatively). The marker is a HINT, not a source of truth.
 *
 * Stored data is PUBLIC/pseudonymous — a commitment (already public on-chain via the Deposited event),
 * a deposit index (already public via /recovery-data), an amount (the deposit amount is public by
 * design), and a timestamp. No secret. Cleared once the note is saved, and on disconnect via
 * resetAllLocalState() so a shared device doesn't leak it to the next user.
 */

export interface DepositMarker {
  commitment: string
  depositIndex: number
  amountMicro: string // bigint serialized
  submittedAt: number // ms epoch
}

const KEY_PREFIX = 'polyshield:deposit_pending:'
export const DEPOSIT_MARKER_KEY_PREFIX = KEY_PREFIX // exported so resetAllLocalState can sweep it

const keyFor = (wallet: string) => `${KEY_PREFIX}${wallet.toLowerCase()}`

function readAll(wallet: string): Record<string, DepositMarker> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(keyFor(wallet))
    return raw ? (JSON.parse(raw) as Record<string, DepositMarker>) : {}
  } catch {
    return {}
  }
}

function writeAll(wallet: string, map: Record<string, DepositMarker>): void {
  if (typeof window === 'undefined') return
  try {
    if (Object.keys(map).length === 0) localStorage.removeItem(keyFor(wallet))
    else localStorage.setItem(keyFor(wallet), JSON.stringify(map))
  } catch {
    /* quota / serialization — non-fatal; the chain remains the source of truth (Restore re-syncs) */
  }
}

/** Record that a deposit was submitted for `commitment` (keyed per wallet). */
export function markDepositSubmitted(wallet: string, m: DepositMarker): void {
  const map = readAll(wallet)
  map[m.commitment.toLowerCase()] = m
  writeAll(wallet, map)
}

export function getDepositMarkers(wallet: string): DepositMarker[] {
  return Object.values(readAll(wallet))
}

export function clearDepositMarker(wallet: string, commitment: string): void {
  const map = readAll(wallet)
  delete map[commitment.toLowerCase()]
  writeAll(wallet, map)
}
