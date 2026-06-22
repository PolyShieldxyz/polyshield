/**
 * Persisted pending-close markers.
 *
 * A LIMIT close rests on Polymarket's order book indefinitely (until it fills, expires, or is
 * cancelled). Rather than trap the user in a blocking modal that polls for a fill, we record that a
 * close is in flight and let the portfolio's background poll detect the operator's SOLD attestation
 * and finalize the credit (see lib/finalizeClose.ts — same pattern as FC-14 partial-fill auto-
 * finalize). The marker lives in localStorage so it SURVIVES a tab close: the user can submit a limit
 * close, leave, and the proceeds land when they return.
 *
 * Stored data is PUBLIC/pseudonymous (a nullifier_of_bet + the user's own order params) — no secret.
 * Cleared on disconnect via resetAllLocalState() so a shared device doesn't leak it to the next user.
 */

export type CloseOrderKind = 'MARKET' | 'LIMIT'

export interface CloseMarker {
  nullifierOfBet: string
  depositIndex: number
  orderKind: CloseOrderKind
  priceCents: number // limit price in cents (0 for a market close)
  expiration: number // GTD lifetime in seconds (0 = GTC / market)
  submittedAt: number // ms epoch
}

const KEY_PREFIX = 'polyshield:close_pending:'
export const CLOSE_MARKER_KEY_PREFIX = KEY_PREFIX // exported so resetAllLocalState can sweep it

const keyFor = (wallet: string) => `${KEY_PREFIX}${wallet.toLowerCase()}`

function readAll(wallet: string): Record<string, CloseMarker> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(keyFor(wallet))
    return raw ? (JSON.parse(raw) as Record<string, CloseMarker>) : {}
  } catch {
    return {}
  }
}

function writeAll(wallet: string, map: Record<string, CloseMarker>): void {
  if (typeof window === 'undefined') return
  try {
    if (Object.keys(map).length === 0) localStorage.removeItem(keyFor(wallet))
    else localStorage.setItem(keyFor(wallet), JSON.stringify(map))
  } catch {
    /* quota / serialization — non-fatal, the close still finalizes via the SOLD attestation */
  }
}

/** Record that a close was submitted for `nullifierOfBet` (keyed per wallet). */
export function markCloseSubmitted(wallet: string, m: CloseMarker): void {
  const map = readAll(wallet)
  map[m.nullifierOfBet.toLowerCase()] = m
  writeAll(wallet, map)
}

export function getCloseMarker(wallet: string, nullifierOfBet: string): CloseMarker | null {
  return readAll(wallet)[nullifierOfBet.toLowerCase()] ?? null
}

export function getCloseMarkers(wallet: string): CloseMarker[] {
  return Object.values(readAll(wallet))
}

export function clearCloseMarker(wallet: string, nullifierOfBet: string): void {
  const map = readAll(wallet)
  delete map[nullifierOfBet.toLowerCase()]
  writeAll(wallet, map)
}
