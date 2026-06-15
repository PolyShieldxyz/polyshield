/**
 * Beta terms-acknowledgement store.
 *
 * During the mainnet beta we ask every wallet to sign a plain-text disclaimer ("experimental
 * software, real funds, use at your own risk") ONCE at connect time, and record (address,
 * signature, message version, timestamp) here.
 *
 * PRIVACY: this is the one place the backend stores a wallet address on purpose — but it is NOT a
 * deanonymization vector. The record says only "address W agreed to the beta terms", which is the
 * same public fact as W's on-chain `Deposited` event. It contains NO secret, NO note data, and NO
 * link to any bet/nullifier. The signed message is a fixed disclaimer string, never proof witness
 * data. Do not extend this table with anything that ties a wallet to its spend activity.
 */

import Database from "better-sqlite3";
import path from "path";
import { ethers } from "ethers";

const DB_PATH = process.env.BETA_CONSENT_DB_PATH ?? path.join(process.cwd(), "beta-consent.db");

// Bump when the disclaimer wording changes; the frontend builds the same string (see lib/betaConsent.ts).
export const CONSENT_VERSION = 1;

/** The exact disclaimer a wallet signs. MUST match the frontend builder byte-for-byte. */
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
    `Address: ${ethers.getAddress(address)}`,
  ].join("\n");
}

let _db: Database.Database | null = null;
function db(): Database.Database {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS beta_consent (
      address    TEXT PRIMARY KEY,
      signature  TEXT NOT NULL,
      version    INTEGER NOT NULL,
      signed_at  INTEGER NOT NULL
    )
  `);
  return _db;
}

export class ConsentError extends Error {}

/**
 * Verify the signature recovers to `address` over the canonical disclaimer, then persist it.
 * Idempotent: re-signing the same address overwrites (e.g. after a version bump). Throws
 * ConsentError on a bad address or a signature that does not match.
 */
export function recordConsent(rawAddress: string, signature: string, signedAtMs: number): { address: string } {
  let address: string;
  try {
    address = ethers.getAddress(rawAddress);
  } catch {
    throw new ConsentError("invalid address");
  }
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new ConsentError("invalid signature format");
  }
  let recovered: string;
  try {
    recovered = ethers.verifyMessage(consentMessage(address), signature);
  } catch {
    throw new ConsentError("signature verification failed");
  }
  if (recovered.toLowerCase() !== address.toLowerCase()) {
    throw new ConsentError("signature does not match address");
  }
  db()
    .prepare(
      `INSERT INTO beta_consent (address, signature, version, signed_at)
       VALUES (@address, @signature, @version, @signed_at)
       ON CONFLICT(address) DO UPDATE SET
         signature = excluded.signature, version = excluded.version, signed_at = excluded.signed_at`,
    )
    .run({ address, signature, version: CONSENT_VERSION, signed_at: Math.floor(signedAtMs) });
  return { address };
}

/** Has this address acknowledged the CURRENT terms version? Used so a returning user isn't re-prompted. */
export function hasConsent(rawAddress: string): boolean {
  let address: string;
  try {
    address = ethers.getAddress(rawAddress);
  } catch {
    return false;
  }
  const row = db()
    .prepare(`SELECT version FROM beta_consent WHERE address = ?`)
    .get(address) as { version: number } | undefined;
  return !!row && row.version >= CONSENT_VERSION;
}
