/**
 * Client helpers for the mainnet-beta terms acknowledgement.
 *
 * On first connect we ask the wallet to sign a fixed disclaimer (experimental software, real funds,
 * use at your own risk) and POST {address, signature} to the relay, which verifies + records it.
 * The signed message MUST match proof-relay/src/betaConsent.ts byte-for-byte or verification fails.
 */
import { getAddress } from 'viem'

// Bump together with CONSENT_VERSION in proof-relay/src/betaConsent.ts when the wording changes.
export const CONSENT_VERSION = 1

/** The exact disclaimer the wallet signs. Keep in sync with the backend consentMessage(). */
export function consentMessage(address: string): string {
  return [
    `PolyShield Beta — Terms Acknowledgement (v${CONSENT_VERSION})`,
    ``,
    `I acknowledge that PolyShield is experimental beta software running on`,
    `Polygon mainnet with real funds. I understand that I use it entirely at`,
    `my own risk and that the PolyShield operators and contributors are not`,
    `liable for any loss of funds. I confirm I am not restricted from using`,
    `this protocol under applicable law.`,
    ``,
    `Address: ${getAddress(address)}`,
  ].join('\n')
}

const localKey = (address: string) => `polyshield:beta_consent:v${CONSENT_VERSION}:${address.toLowerCase()}`

/** Fast synchronous check: did this device already record consent for the current terms version? */
export function hasLocalConsent(address: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(localKey(address)) === '1'
  } catch {
    return false
  }
}

function markLocalConsent(address: string): void {
  try {
    window.localStorage.setItem(localKey(address), '1')
  } catch {
    /* private mode / storage disabled — the modal will just re-check the backend next time */
  }
}

/** Backend check, so a returning user on a fresh device isn't re-prompted. Best-effort. */
export async function fetchConsent(address: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/beta-consent/${encodeURIComponent(address)}`, { cache: 'no-store' })
    if (!res.ok) return false
    const data = (await res.json()) as { consented?: boolean }
    return !!data.consented
  } catch {
    return false
  }
}

/** Record a signed acknowledgement with the relay and remember it locally. Throws on rejection. */
export async function submitConsent(address: string, signature: string): Promise<void> {
  const res = await fetch('/api/beta-consent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: getAddress(address), signature }),
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? `consent record failed (HTTP ${res.status})`)
  }
  markLocalConsent(address)
}
