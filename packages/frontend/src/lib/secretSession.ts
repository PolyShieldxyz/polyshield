/**
 * FC-13: memory-only master-seed session manager.
 *
 * V2 note secrets are derived from a single wallet-signed "master seed" instead of one
 * signature per deposit index (the V1 scheme). The seed is derived ONCE per browser session
 * (the first action that needs a secret) and held HERE, in memory only — never persisted to
 * localStorage / IndexedDB / any server. It is cleared on disconnect and lost on tab close, so
 * a returning user signs once more. This preserves the "the secret is NOT persisted" invariant
 * (CLAUDE.md) while collapsing recovery + every spend in a session to a single signature.
 *
 * Backward compatibility: notes created under the V1 scheme (no master seed; secret = sign per
 * index) still resolve through getNoteSecret(..., version=1). A note's derivationVersion field
 * selects the path; untagged legacy notes default to V1.
 *
 * This module imports only the PURE derivation primitives from notes.ts (one-way dependency),
 * so there is no import cycle.
 */

import { deriveMasterSeed, deriveSecretV1, deriveSecretV2 } from './notes'

type SignFn = (args: { message: string }) => Promise<`0x${string}`>

let session: { address: string; seed: `0x${string}` } | null = null

function sameAddr(a?: string, b?: string): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase()
}

/**
 * Resolve the wallet's master seed, signing exactly once per session. Subsequent calls for the
 * same address return the cached seed with no wallet prompt. Switching address re-signs.
 */
export async function getMasterSeed(
  signMessageAsync: SignFn,
  address: `0x${string}`,
): Promise<`0x${string}`> {
  if (session && sameAddr(session.address, address)) return session.seed
  const seed = await deriveMasterSeed(signMessageAsync, address)
  session = { address: address.toLowerCase(), seed }
  return seed
}

/** True if the master seed for `address` is already unlocked in this session (no prompt needed). */
export function hasMasterSeed(address: `0x${string}`): boolean {
  return !!session && sameAddr(session.address, address)
}

/** Forget the in-memory master seed. Call on wallet disconnect / account switch. */
export function clearSession(): void {
  session = null
}

/**
 * Resolve a note's spending secret, honoring its derivation version (FC-13).
 *  - version 2 (default for new notes): derive from the session master seed (one signature total).
 *  - version 1 (legacy): sign the per-index V1 message.
 */
export async function getNoteSecret(
  signMessageAsync: SignFn,
  address: `0x${string}`,
  index: number,
  version: 1 | 2 = 2,
): Promise<`0x${string}`> {
  if (version === 1) return deriveSecretV1(signMessageAsync, address, index)
  const seed = await getMasterSeed(signMessageAsync, address)
  return deriveSecretV2(seed, index)
}
