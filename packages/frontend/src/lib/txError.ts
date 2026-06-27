/**
 * Human-facing classification of wallet / RPC / on-chain errors.
 *
 * Across the app, deposit/bet/withdraw and the credit modals previously surfaced raw provider
 * strings (`err.message.split('\n')[0]`) — so a user who simply rejected a signature saw a red
 * "Transaction failed" with "User denied transaction signature", and a Solidity revert selector
 * landed as opaque hex at the most anxious moment in a money flow. This util maps the common
 * cases to calm, actionable copy and keeps the raw string available behind a details toggle.
 *
 * Pure and dependency-free (duck-types on shape rather than `instanceof`, which is brittle across
 * viem/wagmi/ethers versions and across the worker/main-thread boundary).
 */

export interface ClassifiedTxError {
  /** 'neutral' = a normal user choice (e.g. they cancelled). 'error' = something actually failed. */
  tone: 'neutral' | 'error'
  title: string
  /** One sentence: what happened and what to do next. */
  body: string
  /** Whether offering a Retry makes sense. */
  retry: boolean
  /** The original first-line message, for an optional "details" disclosure. */
  raw: string
}

/** Pull a usable string + any nested error out of whatever was thrown. */
function extract(err: unknown): { message: string; code?: number; name?: string; text: string } {
  const e = err as
    | { message?: string; shortMessage?: string; code?: number; name?: string; cause?: unknown; details?: string }
    | string
    | undefined
  if (typeof e === 'string') return { message: e, text: e.toLowerCase() }
  const message = (e?.shortMessage || e?.message || e?.details || 'Something went wrong.').split('\n')[0]
  // Walk the cause chain so a wrapped UserRejected / revert name is still detectable.
  const parts: string[] = [message]
  let cur: any = e
  for (let i = 0; i < 5 && cur; i++) {
    if (cur.message) parts.push(String(cur.message))
    if (cur.shortMessage) parts.push(String(cur.shortMessage))
    if (cur.details) parts.push(String(cur.details))
    if (cur.name) parts.push(String(cur.name))
    cur = cur.cause
  }
  // Surface a numeric/string rejection code from anywhere in the chain.
  const code =
    (e as any)?.code ?? (e as any)?.cause?.code ?? (e as any)?.cause?.cause?.code
  return { message, code: typeof code === 'number' ? code : undefined, name: (e as any)?.name, text: parts.join(' ').toLowerCase() }
}

/** Known custom-error / revert names → plain copy + whether a retry helps. */
const KNOWN_REVERTS: Array<{ match: RegExp; body: string; retry: boolean }> = [
  { match: /nullifierspent|already.?spent|note.?spent/, body: 'This note has already been used. Refresh your notes from the Portfolio (Restore) and try again.', retry: false },
  { match: /unknownroot|root.?not.?found|merkle/, body: 'Your proof referenced a Merkle root the chain has rotated past. Wait a few seconds for the index to catch up, then retry.', retry: true },
  { match: /belowminimum|below.?min/, body: 'The amount is below the minimum allowed. Increase it and try again.', retry: false },
  { match: /exceedscap|deposit.?cap|cumulative/, body: 'This would exceed the per-address deposit cap ($50,000). Lower the amount.', retry: false },
  { match: /invalidproof|verifier|verify failed/, body: "The proof didn't verify on-chain. This usually means your note state is out of date — Restore from the Portfolio and retry.", retry: true },
  { match: /insufficient.?(funds|balance|allowance)/, body: "There weren't enough funds or allowance to complete this. Check your balance and retry.", retry: true },
  { match: /paused/, body: 'The vault is paused right now. Please try again later.', retry: true },
]

/** True when the error is the user declining a wallet prompt (every common provider shape). */
export function isUserRejection(err: unknown): boolean {
  const { code, text, name } = extract(err)
  if (code === 4001) return true // EIP-1193 userRejectedRequest
  if (name === 'UserRejectedRequestError') return true
  return (
    /user rejected|user denied|rejected the request|request rejected|action_rejected|denied (transaction|message) signature|user cancelled|user canceled/.test(
      text,
    )
  )
}

export function classifyTxError(err: unknown): ClassifiedTxError {
  const { message, text } = extract(err)

  if (isUserRejection(err)) {
    return {
      tone: 'neutral',
      title: 'Cancelled in your wallet',
      body: 'You dismissed the request. Nothing happened — retry whenever you’re ready.',
      retry: true,
      raw: message,
    }
  }

  // Proof-generation timeout (thrown by lib/prover.ts).
  if (/proof (generation )?tim(ed )?out|timeout/.test(text) && /proof|prove|witness|snark/.test(text)) {
    return {
      tone: 'error',
      title: 'Proof generation timed out',
      body: 'Generating the proof took too long on this device. Try again, ideally on a more powerful device or a desktop browser.',
      retry: true,
      raw: message,
    }
  }

  for (const r of KNOWN_REVERTS) {
    if (r.match.test(text)) {
      return { tone: 'error', title: 'Transaction failed', body: r.body, retry: r.retry, raw: message }
    }
  }

  // Network / RPC.
  if (/network|fetch failed|timeout|econn|rate.?limit|429|503|json-rpc|http request failed/.test(text)) {
    return {
      tone: 'error',
      title: 'Network problem',
      body: 'A network or RPC error interrupted this. Check your connection and retry.',
      retry: true,
      raw: message,
    }
  }

  // Fallback: keep the raw first line, framed neutrally with a retry.
  return {
    tone: 'error',
    title: 'Something went wrong',
    body: message,
    retry: true,
    raw: message,
  }
}
