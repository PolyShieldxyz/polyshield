/**
 * FC-13: master-seed session manager.
 *
 * The headline UX win: ONE wallet signature per session unlocks the master seed; every note
 * secret after that is derived locally with no further prompt. These tests pin that behavior
 * (signature counting), the version dispatch (V2 seed vs V1 per-index), and session lifecycle.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { keccak256, toBytes } from 'viem'
import { getMasterSeed, getNoteSecret, hasMasterSeed, clearSession } from '../secretSession'
import { deriveSecretV1, deriveSecretV2, masterSeedMessageV2 } from '../notes'

const WALLET = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65' as const

// Deterministic fake signer: signature = keccak256(message). Wallets sign the same message to the
// same value (RFC-6979-style determinism), which is exactly what derivation relies on.
function makeSign() {
  return vi.fn(async ({ message }: { message: string }) => keccak256(toBytes(message)))
}

beforeEach(() => {
  clearSession()
  vi.clearAllMocks()
})

describe('secretSession (FC-13)', () => {
  it('derives all V2 note secrets from a single session signature', async () => {
    const sign = makeSign()
    const s0 = await getNoteSecret(sign, WALLET, 0, 2)
    const s1 = await getNoteSecret(sign, WALLET, 1, 2)
    const s2 = await getNoteSecret(sign, WALLET, 2, 2)

    // Exactly ONE signature — the master seed; every per-index secret is local compute.
    expect(sign).toHaveBeenCalledTimes(1)
    // Distinct per index.
    expect(new Set([s0, s1, s2]).size).toBe(3)

    // Matches the pure primitives: seed = keccak(sig(masterMessage)); secret_i = deriveSecretV2.
    const seedSig = keccak256(toBytes(masterSeedMessageV2(WALLET)))
    const seed = keccak256(toBytes(seedSig))
    expect(s0).toBe(deriveSecretV2(seed, 0))
    expect(s1).toBe(deriveSecretV2(seed, 1))
  })

  it('hasMasterSeed reflects session state and clearSession forgets it', async () => {
    const sign = makeSign()
    expect(hasMasterSeed(WALLET)).toBe(false)
    await getMasterSeed(sign, WALLET)
    expect(hasMasterSeed(WALLET)).toBe(true)
    clearSession()
    expect(hasMasterSeed(WALLET)).toBe(false)
  })

  it('version 1 dispatches to per-index signing and never unlocks a master seed', async () => {
    const sign = makeSign()
    const s = await getNoteSecret(sign, WALLET, 3, 1)
    expect(hasMasterSeed(WALLET)).toBe(false)
    // V1 path signs the per-index message; result matches the V1 primitive.
    expect(s).toBe(await deriveSecretV1(sign, WALLET, 3))
  })

  it('re-signs after a session switch (clearSession) — a returning user signs once more', async () => {
    const sign = makeSign()
    await getNoteSecret(sign, WALLET, 0, 2)
    expect(sign).toHaveBeenCalledTimes(1)
    clearSession()
    await getNoteSecret(sign, WALLET, 0, 2)
    expect(sign).toHaveBeenCalledTimes(2)
  })
})
