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
 * INVARIANT — exactly one BET-OUTCOME attestation per bet. The bet outcome
 * (FILLED / FAILED / PARTIAL) is mutually exclusive: the chain cannot adjudicate two
 * contradictory operator signatures, so once any of those exists for a `nullifierOfBet`
 * we never re-sign or overwrite it (single-write within the outcome group).
 *
 * SOLD (position close) is NOT a bet outcome — it is a SEPARATE, later lifecycle event
 * that legitimately follows a FILLED bet (you sold the position you held). It therefore
 * gets its OWN slot, keyed by (nullifierOfBet, reportType), and coexists with the bet
 * outcome. (Before this, the single-write-by-nullifier store silently dropped the SOLD
 * attestation when a FILLED one already existed, so position close could never complete.)
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
  // Composite PK (nullifier_of_bet, report_type): the bet-outcome group {FILLED,FAILED,
  // PARTIAL} is kept mutually exclusive in application code (see signAndStoreAttestation),
  // while SOLD gets its own row so a position close can be attested after a FILLED bet.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS attestations (
      nullifier_of_bet TEXT NOT NULL,
      report_type INTEGER NOT NULL,
      amount_a TEXT NOT NULL,
      amount_b TEXT NOT NULL,
      signature TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (nullifier_of_bet, report_type)
    )
  `);
  return _db;
}

/** The mutually-exclusive bet-OUTCOME report types (a bet ends as exactly one of these). */
const BET_OUTCOME_TYPES = [ReportType.FILLED, ReportType.FAILED, ReportType.PARTIAL];
function isBetOutcome(reportType: number): boolean {
  return BET_OUTCOME_TYPES.includes(reportType as ReportType);
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

/** Read the bet-OUTCOME row (FILLED/FAILED/PARTIAL) for a bet, if any. */
function readOutcomeRow(nullifierOfBet: string): AttestationRow | undefined {
  return db()
    .prepare(
      `SELECT nullifier_of_bet, report_type, amount_a, amount_b, signature
         FROM attestations
        WHERE nullifier_of_bet = ? AND report_type IN (?, ?, ?)`,
    )
    .get(nullifierOfBet, ReportType.FILLED, ReportType.FAILED, ReportType.PARTIAL) as
    | AttestationRow
    | undefined;
}

/** Read the row for a specific (nullifier, reportType) slot, if any. */
function readTypedRow(nullifierOfBet: string, reportType: number): AttestationRow | undefined {
  return db()
    .prepare(
      `SELECT nullifier_of_bet, report_type, amount_a, amount_b, signature
         FROM attestations WHERE nullifier_of_bet = ? AND report_type = ?`,
    )
    .get(nullifierOfBet, reportType) as AttestationRow | undefined;
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
  // Single-write within the relevant slot:
  //  - a bet OUTCOME (FILLED/FAILED/PARTIAL) is blocked if ANY outcome already exists
  //    (they are mutually exclusive — the first terminal bet result wins);
  //  - SOLD has its own slot and is blocked only by a prior SOLD.
  const existing = isBetOutcome(input.reportType)
    ? readOutcomeRow(input.nullifierOfBet)
    : readTypedRow(input.nullifierOfBet, input.reportType);
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
  // authoritative row for this exact (nullifier, reportType) slot.
  db()
    .prepare(
      `INSERT INTO attestations
         (nullifier_of_bet, report_type, amount_a, amount_b, signature, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(nullifier_of_bet, report_type) DO NOTHING`,
    )
    .run(
      input.nullifierOfBet,
      input.reportType,
      input.amountA.toString(),
      input.amountB.toString(),
      signature,
      Math.floor(Date.now() / 1000),
    );

  const stored = readTypedRow(input.nullifierOfBet, input.reportType);
  // stored is always defined here (we either inserted our row or the racing one won).
  return stored ? rowToAttestation(stored) : {
    nullifierOfBet: input.nullifierOfBet,
    reportType: input.reportType,
    amountA: input.amountA.toString(),
    amountB: input.amountB.toString(),
    signature,
  };
}

/**
 * Fetch an attestation for a bet.
 *  - With `reportType` → that exact slot (e.g. SOLD=4 for a position close).
 *  - Without → the bet-OUTCOME attestation (FILLED/FAILED/PARTIAL). This is what the
 *    signing-layer dedupe and the default frontend fetch want ("has this bet's order
 *    reached a terminal result yet?"), and it never returns a SOLD row by accident.
 */
export function getAttestation(nullifierOfBet: string, reportType?: number): Attestation | null {
  const row =
    reportType !== undefined
      ? readTypedRow(nullifierOfBet, reportType)
      : readOutcomeRow(nullifierOfBet);
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
 * Durable record that a MARKET (FAK) order was submitted (or is being submitted) to the CLOB
 * for a bet. Unlike a resting GTC/GTD order, a FAK leaves no tracked-order entry (wsFillTracker),
 * so without this marker `/cancel-bet` had no way to tell "no order was ever placed" (safe to
 * attest FAILED) apart from "an order was placed and may have filled" (NEVER safe to blind-FAILED
 * — that reclaims a position the pool actually bought). The marker is written BEFORE the CLOB POST,
 * so its ABSENCE is proof no order was placed; its PRESENCE forces cancel-bet to reconcile the true
 * fill instead of blind-attesting FAILED. Survives a process restart (the in-memory in-flight set
 * does not), closing the restart-mid-submission double-spend window. order_id is filled in once the
 * CLOB returns it, so a reconcile can query getOrder/getTrades by id.
 */
export interface MarketSubmission {
  conditionId: string;
  orderId: string | null;
  submittedAt: number;
}

function ensureMarketSubmissionsTable(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS market_submissions (
      nullifier_of_bet TEXT PRIMARY KEY,
      condition_id TEXT NOT NULL,
      order_id TEXT,
      submitted_at INTEGER NOT NULL
    )
  `);
}

/** Record that a market (FAK) order is about to be / has been POSTed to the CLOB. Idempotent. */
export function markMarketSubmitting(nullifierOfBet: string, conditionId: string): void {
  const d = db();
  ensureMarketSubmissionsTable(d);
  d.prepare(
    `INSERT INTO market_submissions (nullifier_of_bet, condition_id, order_id, submitted_at)
     VALUES (?, ?, NULL, ?) ON CONFLICT(nullifier_of_bet) DO NOTHING`,
  ).run(nullifierOfBet, conditionId, Math.floor(Date.now() / 1000));
}

/** Attach the CLOB order id to a recorded market submission (best-effort; for later reconcile). */
export function setMarketOrderId(nullifierOfBet: string, orderId: string): void {
  if (!orderId) return;
  const d = db();
  ensureMarketSubmissionsTable(d);
  d.prepare(`UPDATE market_submissions SET order_id = ? WHERE nullifier_of_bet = ?`).run(
    orderId,
    nullifierOfBet,
  );
}

/** The market-submission record for a bet, or null if no FAK order was ever submitted. */
export function getMarketSubmission(nullifierOfBet: string): MarketSubmission | null {
  const d = db();
  ensureMarketSubmissionsTable(d);
  const row = d
    .prepare(
      `SELECT condition_id, order_id, submitted_at FROM market_submissions WHERE nullifier_of_bet = ?`,
    )
    .get(nullifierOfBet) as { condition_id: string; order_id: string | null; submitted_at: number } | undefined;
  return row ? { conditionId: row.condition_id, orderId: row.order_id ?? null, submittedAt: row.submitted_at } : null;
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
