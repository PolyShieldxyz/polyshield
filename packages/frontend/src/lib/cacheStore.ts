/**
 * FC-13: encrypted-at-rest persistence for the note cache.
 *
 * The note cache (commitments, nullifiers, balances, bet-receipt linkage, activity) is the
 * de-anonymizing client state. It used to sit in PLAINTEXT localStorage, which is trivially
 * read by other scripts on the origin, browser extensions, and backup/sync tools. This module
 * moves it to IndexedDB, encrypted with a non-extractable AES-GCM key.
 *
 * Threat model (deliberate, see docs/threat-model.md / docs/future-changes.md FC-13):
 *  - The AES-GCM key is generated once and stored AS A CryptoKey OBJECT in IndexedDB with
 *    `extractable: false`. Its raw bytes can never be read back by any script (a script can only
 *    USE the opaque handle to encrypt/decrypt). This raises the bar against casual inspection,
 *    extensions, and sync scrapers — it is NOT protection against a fully compromised device that
 *    can drive the page's own crypto. That is an accepted limitation; note SECRETS are never
 *    persisted regardless (see secretSession.ts), so even a full IDB dump yields no spendable key.
 *  - No wallet signature is required to read the cache, so the portfolio hydrates instantly.
 *
 * All operations are best-effort: any failure (no IndexedDB, no WebCrypto, quota, private mode)
 * is swallowed and degrades to "no persistence" rather than throwing into the app. Reads return
 * null; the caller falls back to the in-memory cache / on-chain recovery.
 */

const DB_NAME = 'polyshield'
const DB_VERSION = 1
const STORE = 'kv'
// Where the non-extractable AES-GCM CryptoKey lives inside the same store.
const KEY_ID = '__cache_key_v1__'

type EncRecord = { iv: Uint8Array; ct: ArrayBuffer }

function available(): boolean {
  return (
    typeof indexedDB !== 'undefined' &&
    typeof crypto !== 'undefined' &&
    typeof crypto.subtle !== 'undefined'
  )
}

let dbPromise: Promise<IDBDatabase> | null = null
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function idbGet<T>(key: string): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly')
        const req = tx.objectStore(STORE).get(key)
        req.onsuccess = () => resolve(req.result as T | undefined)
        req.onerror = () => reject(req.error)
      }),
  )
}

function idbPut(key: string, value: unknown): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).put(value, key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      }),
  )
}

function idbDelete(key: string): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).delete(key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      }),
  )
}

let keyPromise: Promise<CryptoKey> | null = null
function getKey(): Promise<CryptoKey> {
  if (keyPromise) return keyPromise
  keyPromise = (async () => {
    const existing = await idbGet<CryptoKey>(KEY_ID)
    if (existing) return existing
    // extractable: false → the raw key material can never be exported, only used in-page.
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ])
    await idbPut(KEY_ID, key)
    return key
  })()
  return keyPromise
}

async function encrypt(plaintext: string): Promise<EncRecord> {
  const key = await getKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = new TextEncoder().encode(plaintext)
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    data as BufferSource,
  )
  return { iv, ct }
}

async function decrypt(rec: EncRecord): Promise<string> {
  const key = await getKey()
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: rec.iv as BufferSource },
    key,
    rec.ct,
  )
  return new TextDecoder().decode(pt)
}

/** Read + decrypt a value. Returns null on any error or missing key (caller falls back). */
export async function readEncrypted(key: string): Promise<string | null> {
  if (!available()) return null
  try {
    const rec = await idbGet<EncRecord>(key)
    if (!rec || !rec.ct) return null
    return await decrypt(rec)
  } catch {
    return null
  }
}

/** Encrypt + write a value. Best-effort: swallows all errors (degrades to no persistence). */
export async function writeEncrypted(key: string, plaintext: string): Promise<void> {
  if (!available()) return
  try {
    await idbPut(key, await encrypt(plaintext))
  } catch {
    /* persistence unavailable — in-memory cache + on-chain recovery remain authoritative */
  }
}

/** Delete one cached value (e.g. on disconnect). Keeps the crypto key so re-use still works. */
export async function removeEncrypted(key: string): Promise<void> {
  if (!available()) return
  try {
    await idbDelete(key)
  } catch {
    /* ignore */
  }
}
