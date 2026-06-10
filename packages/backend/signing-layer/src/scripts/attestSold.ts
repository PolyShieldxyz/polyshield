/**
 * One-off OPERATOR recovery: sign a SOLD attestation for a position whose FOK SELL already
 * executed on Polymarket but whose SOLD attestation was lost (the close was requested before the
 * fill-confirmation fix). It does NOT submit a SELL — the shares are already gone from the pooled
 * deposit wallet, so re-selling would dump shares owed to other depositors.
 *
 * Operator-only by construction: it runs inside the signing-layer process (has the vault/operator
 * key + the live settlement.db) and is NOT an HTTP route, so it can't be reached from a browser.
 *
 * After running it, re-open "Close" in the UI: submitFOKSellOrder sees the existing SOLD attestation
 * and skips the SELL (idempotency guard), pollUntilSold finds it, and the closePosition proof books
 * the loss on-chain.
 *
 * Usage (in the running container — built to dist/):
 *   # 1. List pending closes (no SOLD attestation yet) — read from the persistent DB, not logs:
 *   docker compose exec signing-layer node dist/scripts/attestSold.js
 *   # 2. Recover one by its nullifier_of_bet:
 *   docker compose exec signing-layer node dist/scripts/attestSold.js <nullifier_of_bet> [proceedsMicroUSDC]
 * Or in dev: pnpm --filter @polyshield/signing-layer attest-sold [<nullifier_of_bet> [proceeds]]
 *
 * proceeds defaults to sold_shares × the close request's limit price (1e6-scaled) — conservative
 * and pool-safe (a SELL fills at ≥ its limit). Pass an explicit micro-USDC amount to override with
 * the realized proceeds read from Polymarket's trade history.
 */

import { ethers } from "ethers";
import pino from "pino";
import Database from "better-sqlite3";
import path from "path";
import { config } from "../config";
import { signAndStoreAttestation, getAttestation, ReportType } from "../attestationStore";

const logger = pino({ name: "attest-sold" });

// betRecords getter — sold_shares MUST equal the on-chain expected_shares (the Vault's closePosition
// requires att.amountA == rec.expected_shares for a full close).
const BET_RECORDS_ABI = [
  "function betRecords(bytes32) view returns (bytes32 market_id, bytes32 condition_id, bytes32 position_id, uint64 expected_shares, uint64 bet_amount, uint8 outcome_side, uint8 status)",
];

function dbPath(): string {
  return process.env.SETTLEMENT_DB_PATH ?? path.join(process.cwd(), "settlement.db");
}

interface CloseRow {
  nullifier_of_bet: string;
  sold_shares: string;
  limit_price: string;
  requested_at: number;
}

/** List close requests that have NO SOLD attestation yet (the recoverable / stuck ones). */
function listCandidates(): void {
  const db = new Database(dbPath(), { readonly: true });
  let rows: CloseRow[];
  try {
    rows = db
      .prepare(
        `SELECT nullifier_of_bet, sold_shares, limit_price, requested_at
           FROM close_requests ORDER BY requested_at DESC`,
      )
      .all() as CloseRow[];
  } catch {
    rows = []; // table may not exist yet (no close ever requested)
  } finally {
    db.close();
  }

  const seen = new Set<string>();
  const candidates: CloseRow[] = [];
  for (const r of rows) {
    if (seen.has(r.nullifier_of_bet)) continue; // dedupe repeated close attempts for one bet
    seen.add(r.nullifier_of_bet);
    if (getAttestation(r.nullifier_of_bet, ReportType.SOLD)) continue; // already recovered/closed
    candidates.push(r);
  }

  if (candidates.length === 0) {
    console.log("No pending close requests without a SOLD attestation — nothing to recover.");
    return;
  }
  console.log("Pending closes (no SOLD attestation yet). Recover one with:\n  node dist/scripts/attestSold.js <nullifier_of_bet>\n");
  for (const c of candidates) {
    const shares = BigInt(c.sold_shares);
    const proceeds = (shares * BigInt(c.limit_price)) / 1_000_000n;
    console.log(
      `  ${c.nullifier_of_bet}\n` +
        `    shares=${(Number(shares) / 1e6).toFixed(2)}  limit=${(Number(c.limit_price) / 1e6).toFixed(3)}` +
        `  proceeds≈$${(Number(proceeds) / 1e6).toFixed(2)}  requested=${new Date(c.requested_at * 1000).toISOString()}\n`,
    );
  }
}

async function attestOne(nullifier: string, proceedsArg: string | undefined): Promise<void> {
  // Idempotent — never overwrite an existing SOLD (single-write store).
  if (getAttestation(nullifier, ReportType.SOLD)) {
    logger.info({ nullifier }, "SOLD attestation already exists — nothing to do (re-open Close to finish)");
    return;
  }

  const provider = new ethers.JsonRpcProvider(config.polygonRpcUrl);
  const wallet = new ethers.Wallet(config.vaultEoaPrivateKey, provider);
  const network = await provider.getNetwork();

  if (wallet.address.toLowerCase() !== config.signingLayerOperatorAddress.toLowerCase()) {
    logger.error(
      { walletAddress: wallet.address, expectedOperator: config.signingLayerOperatorAddress },
      "VAULT_EOA_PRIVATE_KEY is not the signingLayerOperator — the attestation would be REJECTED on-chain",
    );
    process.exit(1);
  }

  // sold_shares = on-chain expected_shares (the held position; normalized down if it was a partial).
  const vault = new ethers.Contract(config.vaultContractAddress, BET_RECORDS_ABI, provider);
  const rec = await vault.betRecords(nullifier);
  const soldShares = BigInt(rec.expected_shares ?? rec[3]);
  if (soldShares <= 0n) {
    logger.error({ nullifier }, "bet has no shares (expected_shares == 0) — cannot attest SOLD");
    process.exit(1);
  }

  // proceeds: explicit arg, else sold_shares × the close request's limit price (both 1e6-scaled).
  let proceeds: bigint;
  if (proceedsArg) {
    if (!/^[0-9]+$/.test(proceedsArg)) {
      logger.error({ proceedsArg }, "proceeds must be an integer (micro-USDC, 1e6-scaled)");
      process.exit(1);
    }
    proceeds = BigInt(proceedsArg);
  } else {
    const db = new Database(dbPath(), { readonly: true });
    const cr = db
      .prepare(`SELECT limit_price FROM close_requests WHERE nullifier_of_bet = ? ORDER BY requested_at DESC LIMIT 1`)
      .get(nullifier) as { limit_price?: string } | undefined;
    db.close();
    if (!cr?.limit_price) {
      logger.error(
        { nullifier },
        "no close_request on file for this bet — pass an explicit proceeds (micro-USDC) argument",
      );
      process.exit(1);
    }
    proceeds = (soldShares * BigInt(cr.limit_price)) / 1_000_000n;
  }

  await signAndStoreAttestation(
    wallet,
    { chainId: Number(network.chainId), verifyingContract: config.vaultContractAddress },
    { nullifierOfBet: nullifier, reportType: ReportType.SOLD, amountA: soldShares, amountB: proceeds },
  );

  logger.info(
    { nullifier, sold_shares: soldShares.toString(), proceeds: proceeds.toString() },
    "SOLD attestation signed + stored — re-open Close in the UI to finish (it will skip the SELL and book the loss)",
  );
}

async function main(): Promise<void> {
  const nullifier = process.argv[2];
  // No nullifier → list the recoverable (stuck) closes from the persistent DB (logs may be gone
  // after a container rebuild; the close_requests table lives in the /data volume).
  if (!nullifier) {
    listCandidates();
    return;
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(nullifier)) {
    logger.error("usage: attestSold [<nullifier_of_bet 0x..64> [proceedsMicroUSDC]]  (no args → list candidates)");
    process.exit(1);
  }
  await attestOne(nullifier, process.argv[3]);
}

main().catch((err) => {
  logger.error({ err: String(err) }, "attestSold failed");
  process.exit(1);
});
