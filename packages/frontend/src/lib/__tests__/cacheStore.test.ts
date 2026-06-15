/**
 * FC-13: encrypted-at-rest note cache (IndexedDB + AES-GCM).
 *
 * Verifies the round-trip through real WebCrypto + (fake) IndexedDB, that missing keys read back
 * as null, that delete works, and — the security point — that what lands in IndexedDB is
 * CIPHERTEXT, never the plaintext the caller wrote.
 */

import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { readEncrypted, writeEncrypted, removeEncrypted } from '../cacheStore'

describe('cacheStore (FC-13)', () => {
  it('round-trips an encrypted value', async () => {
    const payload = JSON.stringify({ hello: 'world', n: 42 })
    await writeEncrypted('polyshield:test:notes', payload)
    expect(await readEncrypted('polyshield:test:notes')).toBe(payload)
  })

  it('returns null for a missing key', async () => {
    expect(await readEncrypted('polyshield:test:absent')).toBeNull()
  })

  it('removes a value', async () => {
    await writeEncrypted('polyshield:test:rm', 'gone-soon')
    expect(await readEncrypted('polyshield:test:rm')).toBe('gone-soon')
    await removeEncrypted('polyshield:test:rm')
    expect(await readEncrypted('polyshield:test:rm')).toBeNull()
  })

  it('stores ciphertext, not plaintext', async () => {
    const secretish = 'BET_RECEIPT:market-0xabc:linkage'
    await writeEncrypted('polyshield:test:cipher', secretish)
    // Read the raw stored record directly out of IndexedDB and confirm it is not the plaintext.
    const raw = await new Promise<unknown>((resolve, reject) => {
      const open = indexedDB.open('polyshield', 1)
      open.onsuccess = () => {
        const db = open.result
        const tx = db.transaction('kv', 'readonly')
        const rq = tx.objectStore('kv').get('polyshield:test:cipher')
        rq.onsuccess = () => resolve(rq.result)
        rq.onerror = () => reject(rq.error)
      }
      open.onerror = () => reject(open.error)
    })
    const serialized = JSON.stringify(raw, (_k, v) =>
      v instanceof ArrayBuffer ? Array.from(new Uint8Array(v)) : v,
    )
    expect(serialized).not.toContain(secretish)
    expect(serialized).not.toContain('BET_RECEIPT')
    // It does carry the AES-GCM shape (iv + ct).
    expect(raw).toHaveProperty('iv')
    expect(raw).toHaveProperty('ct')
  })
})
