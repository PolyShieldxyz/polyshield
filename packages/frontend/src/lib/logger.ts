/**
 * Structured session logger for GUI testing analysis.
 *
 * Every call emits a JSON line to:
 *   1. browser console  (human-readable in DevTools)
 *   2. POST /api/dev/log  →  logs/frontend.jsonl  (machine-readable, for later analysis)
 *
 * PRIVACY RULES (hardcoded, non-negotiable):
 *   - Never log note.secret or any field containing a secret preimage
 *   - Nullifiers and commitments are fine (they are public on-chain)
 *   - Wallet addresses are fine (they are public)
 *   - Proof bytes are logged by size + keccak fingerprint, NOT full hex
 */

// One UUID per browser session — correlates all events from the same user journey
const SESSION_ID: string =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 18)

export interface LogEntry {
  ts: string
  session: string
  service: 'frontend'
  event: string
  page: string
  duration_ms?: number
  data?: Record<string, unknown>
}

function nowIso(): string {
  return new Date().toISOString()
}

function currentPage(): string {
  if (typeof window === 'undefined') return 'ssr'
  return window.location.pathname + window.location.search
}

let postDisabled = false

function postToServer(entry: LogEntry): void {
  if (typeof window === 'undefined' || postDisabled) return
  // fire-and-forget — never block UI on logging
  void fetch('/api/dev/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
    keepalive: true,
  }).catch(() => {
    postDisabled = true // server not reachable — stop trying (don't spam errors)
  })
}

export function log(event: string, data?: Record<string, unknown>, durationMs?: number): void {
  const entry: LogEntry = {
    ts: nowIso(),
    session: SESSION_ID,
    service: 'frontend',
    event,
    page: currentPage(),
    ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
    ...(data ? { data } : {}),
  }
  // Pretty prefix so it stands out in DevTools vs. app noise
  console.log(`%c[LOG] ${entry.ts}  ${event}`, 'color:#7dd3fc;font-weight:bold', entry.data ?? '')
  postToServer(entry)
}

/**
 * Creates a timer. Call the returned function to emit the event with elapsed ms.
 *
 * Usage:
 *   const done = timer('proof_generate')
 *   await generateProof()
 *   done({ circuit: 'BET_AUTH' })   // logs with duration_ms
 */
export function timer(event: string): (extra?: Record<string, unknown>) => void {
  const start = performance.now()
  return (extra?: Record<string, unknown>) => {
    log(event, extra, Math.round(performance.now() - start))
  }
}

/** Summarise a hex proof for logging (size in bytes + first/last 4 bytes as fingerprint). */
export function proofSummary(hexProof: string): Record<string, unknown> {
  const hex = hexProof.startsWith('0x') ? hexProof.slice(2) : hexProof
  const bytes = Math.floor(hex.length / 2)
  const fp = bytes > 8 ? `${hex.slice(0, 8)}…${hex.slice(-8)}` : hex
  return { proof_bytes: bytes, proof_fingerprint: fp }
}
