/**
 * FC-9: gasless operator reporting.
 *
 * The Vault no longer exposes on-chain report* functions (reportFilled /
 * reportFOKFailure / reportResting / reportPartialFill / reportSold). Instead the
 * operator signs an EIP-712 `OperatorAttestation` OFF-CHAIN about a bet's terminal
 * outcome and persists it here. The user later fetches the attestation (via the
 * public GET /attestation/:nullifier endpoint) and submits it alongside their
 * credit proof; the Vault recovers the signer on-chain and requires it to equal
 * `signingLayerOperator`.
 *
 * HARD INVARIANT — exactly one terminal attestation per bet. Once a row exists for
 * a `nullifierOfBet` we never re-sign and never overwrite it: the chain cannot
 * adjudicate two contradictory operator signatures, so the store is single-write
 * (INSERT ... ON CONFLICT DO NOTHING + read-back).
 *
 * Stored in the same SQLite DB as auto-settlement / limit orders
 * (process.cwd()/settlement.db by default), mirroring limitOrderStore.ts.
 */

import Database from "better-sqlite3";
import path from "path";
import { ethers } from "ethers";

/** Terminal report types — must match the Vault's on-chain enum exactly. */
export enum ReportType {
  FILLED = 1,
  FAILED = 2,
  PARTIAL = 3, // amountA = filled_shares, amountB = spent_amount
  SOLD = 4, // amountA = sold_shares,  amountB = proceeds
}

/** EIP-712 domain parameters, read once at startup so signing is deterministic. */
export interface AttestationDomainParams {
  chainId: number;
  verifyingContract: string;
}

export interface AttestationInput {
  nullifierOfBet: string;
  reportType: ReportType;
  /** uint64 — 0 for FILLED/FAILED; filled_shares (PARTIAL) / sold_shares (SOLD). */
  amountA: bigint;
  /** uint64 — 0 for FILLED/FAILED; spent_amount (PARTIAL) / proceeds (SOLD). */
  amountB: bigint;
}

export interface Attestation {
  nullifierOfBet: string;
  reportType: number;
  /** decimal string (uint64). */
  amountA: string;
  /** decimal string (uint64). */
  amountB: string;
  signature: string;
}

const EIP712_TYPES = {
  OperatorAttestation: [
    { name: "nullifierOfBet", type: "bytes32" },
    { name: "reportType", type: "uint8" },
    { name: "amountA", type: "uint64" },
    { name: "amountB", type: "uint64" },
  ],
} as const;

const DB_PATH = process.env.SETTLEMENT_DB_PATH ?? path.join(process.cwd(), "settlement.db");

let _db: Database.Database | null = null;

function db(): Database.Database {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS attestations (
      nullifier_of_bet TEXT PRIMARY KEY,
      report_type INTEGER NOT NULL,
      amount_a TEXT NOT NULL,
      amount_b TEXT NOT NULL,
      signature TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  return _db;
}

interface AttestationRow {
  nullifier_of_bet: string;
  report_type: number;
  amount_a: string;
  amount_b: string;
  signature: string;
}

function rowToAttestation(row: AttestationRow): Attestation {
  return {
    nullifierOfBet: row.nullifier_of_bet,
    reportType: row.report_type,
    amountA: row.amount_a,
    amountB: row.amount_b,
    signature: row.signature,
  };
}

function readRow(nullifierOfBet: string): AttestationRow | undefined {
  return db()
    .prepare(
      `SELECT nullifier_of_bet, report_type, amount_a, amount_b, signature
         FROM attestations WHERE nullifier_of_bet = ?`,
    )
    .get(nullifierOfBet) as AttestationRow | undefined;
}

/**
 * Sign an EIP-712 OperatorAttestation with the operator wallet and persist it.
 *
 * IDEMPOTENT / SINGLE-WRITE: if a row already exists for `nullifierOfBet` the
 * existing attestation is returned WITHOUT re-signing or overwriting — this
 * enforces the "exactly one terminal attestation per bet" invariant.
 */
export async function signAndStoreAttestation(
  wallet: ethers.Wallet,
  domainParams: AttestationDomainParams,
  input: AttestationInput,
): Promise<Attestation> {
  // Fast path: already attested → return the existing row, never re-sign.
  const existing = readRow(input.nullifierOfBet);
  if (existing) return rowToAttestation(existing);

  const domain = {
    name: "Polyshield",
    version: "1",
    chainId: domainParams.chainId,
    verifyingContract: domainParams.verifyingContract,
  };

  const value = {
    nullifierOfBet: input.nullifierOfBet,
    reportType: input.reportType,
    amountA: input.amountA,
    amountB: input.amountB,
  };

  const signature = await wallet.signTypedData(domain, EIP712_TYPES as unknown as Record<string, ethers.TypedDataField[]>, value);

  // Single-write: ON CONFLICT DO NOTHING guards against a concurrent signer that
  // raced us between the read above and this insert. We then read back the
  // authoritative row (which may be the other writer's, not ours).
  db()
    .prepare(
      `INSERT INTO attestations
         (nullifier_of_bet, report_type, amount_a, amount_b, signature, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(nullifier_of_bet) DO NOTHING`,
    )
    .run(
      input.nullifierOfBet,
      input.reportType,
      input.amountA.toString(),
      input.amountB.toString(),
      signature,
      Math.floor(Date.now() / 1000),
    );

  const stored = readRow(input.nullifierOfBet);
  // stored is always defined here (we either inserted our row or the racing one won).
  return stored ? rowToAttestation(stored) : {
    nullifierOfBet: input.nullifierOfBet,
    reportType: input.reportType,
    amountA: input.amountA.toString(),
    amountB: input.amountB.toString(),
    signature,
  };
}

export function getAttestation(nullifierOfBet: string): Attestation | null {
  const row = readRow(nullifierOfBet);
  return row ? rowToAttestation(row) : null;
}

/**
 * FC-9: optional, NON-BINDING "resting" UI signal. Under FC-9, RESTING is no longer
 * represented on-chain (the Vault has no reportResting). We record it here purely so
 * a UI can show a limit order is live on the book. Nothing is signed and no proof
 * depends on it; it is overwritten by the eventual terminal attestation's meaning.
 */
export function markResting(nullifierOfBet: string): void {
  db()
    .prepare(
      `CREATE TABLE IF NOT EXISTS resting_orders (
         nullifier_of_bet TEXT PRIMARY KEY,
         created_at INTEGER NOT NULL
       )`,
    )
    .run();
  db()
    .prepare(
      `INSERT INTO resting_orders (nullifier_of_bet, created_at)
       VALUES (?, ?) ON CONFLICT(nullifier_of_bet) DO NOTHING`,
    )
    .run(nullifierOfBet, Math.floor(Date.now() / 1000));
}

/**
 * Module-level EIP-712 domain params, resolved once at startup (index.ts reads the
 * chainId from provider.getNetwork() and the verifyingContract from config). The
 * order builder reads this so the terminal-state call sites don't each have to
 * plumb chainId through. Must be set before any attestation is signed.
 */
let _domainParams: AttestationDomainParams | null = null;

export function setAttestationDomainParams(params: AttestationDomainParams): void {
  _domainParams = params;
}

export function getAttestationDomainParams(): AttestationDomainParams {
  if (!_domainParams) {
    throw new Error(
      "attestation domain params not initialized — call setAttestationDomainParams() at startup",
    );
  }
  return _domainParams;
}
