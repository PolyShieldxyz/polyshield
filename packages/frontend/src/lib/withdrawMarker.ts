/**
 * Persisted pending-withdrawal markers.
 *
 * A withdrawal generates a 30s–2min proof, then submits to the relay and waits for confirmation. If
 * the tab is closed/refreshed AFTER the on-chain tx lands but BEFORE the local note-cache update runs
 * (markNoteSpent / addNote ~withdraw page), the local view can drift from chain truth. Rather than
 * trap the user, we record that a withdrawal is in flight: on the next mount we surface a one-line,
 * non-alarming hint pointing at the Portfolio's Restore (which re-syncs notes from chain). We do NOT
 * attempt automatic on-chain reconciliation here — Restore already does that authoritatively.
 *
 * Stored data is PUBLIC/pseudonymous (a nullifier + a timestamp) — no secret, no amount, no recipient.
 * Cleared on disconnect via resetAllLocalState() so a shared device doesn't leak it to the next user.
 */

export interface WithdrawMarker {
  nullifier: string
  submittedAt: number // ms epoch
}

const KEY_PREFIX = 'polyshield:withdraw_pending:'
export const WITHDRAW_MARKER_KEY_PREFIX = KEY_PREFIX // exported so resetAllLocalState can sweep it

const keyFor = (wallet: string) => `${KEY_PREFIX}${wallet.toLowerCase()}`

function readAll(wallet: string): Record<string, WithdrawMarker> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(keyFor(wallet))
    return raw ? (JSON.parse(raw) as Record<string, WithdrawMarker>) : {}
  } catch {
    return {}
  }
}

function writeAll(wallet: string, map: Record<string, WithdrawMarker>): void {
  if (typeof window === 'undefined') return
  try {
    if (Object.keys(map).length === 0) localStorage.removeItem(keyFor(wallet))
    else localStorage.setItem(keyFor(wallet), JSON.stringify(map))
  } catch {
    /* quota / serialization — non-fatal, the chain remains the source of truth (Restore re-syncs) */
  }
}

/** Record that a withdrawal was submitted for `nullifier` (keyed per wallet). */
export function markWithdrawSubmitted(wallet: string, m: WithdrawMarker): void {
  const map = readAll(wallet)
  map[m.nullifier.toLowerCase()] = m
  writeAll(wallet, map)
}

export function getWithdrawMarkers(wallet: string): WithdrawMarker[] {
  return Object.values(readAll(wallet))
}

export function clearWithdrawMarker(wallet: string, nullifier: string): void {
  const map = readAll(wallet)
  delete map[nullifier.toLowerCase()]
  writeAll(wallet, map)
}
