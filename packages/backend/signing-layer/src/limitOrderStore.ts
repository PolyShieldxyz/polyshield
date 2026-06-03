/**
 * FC-4: persistent store for limit-order intents.
 *
 * An advanced-mode bet is relayed as a normal `authorizeBet` (Flow B: full debit
 * up front, circuit untouched). The frontend separately registers the intent that
 * the bet's order should be a resting GTC/GTD limit order rather than the default
 * FOK. The event listener consults this store when a BetAuthorized event fires to
 * decide which order type to submit.
 *
 * Stored in the same SQLite DB as auto-settlement (process.cwd()/settlement.db by
 * default) via a single module-level connection shared across the signing layer.
 */

import Database from "better-sqlite3";
import path from "path";

// FOK is the default (no intent recorded). The intent store covers the non-default
// order types: resting limit orders (GTC/GTD) and the FAK market order.
export type LimitOrderType = "GTC" | "GTD" | "FAK";

export interface LimitOrderIntent {
  nullifier_of_bet: string;
  order_type: LimitOrderType;
  /** GTD effective lifetime in seconds (0 / undefined for GTC and FAK). */
  expiration: number;
}

const DB_PATH = process.env.SETTLEMENT_DB_PATH ?? path.join(process.cwd(), "settlement.db");

let _db: Database.Database | null = null;

function db(): Database.Database {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS limit_orders (
      nullifier_of_bet TEXT PRIMARY KEY,
      order_type TEXT NOT NULL,
      expiration INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `);
  return _db;
}

export function recordLimitOrder(intent: LimitOrderIntent): void {
  db()
    .prepare(`
      INSERT INTO limit_orders (nullifier_of_bet, order_type, expiration, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(nullifier_of_bet) DO UPDATE SET
        order_type = excluded.order_type,
        expiration = excluded.expiration
    `)
    .run(intent.nullifier_of_bet, intent.order_type, intent.expiration, Math.floor(Date.now() / 1000));
}

export function getLimitOrder(nullifier_of_bet: string): LimitOrderIntent | null {
  const row = db()
    .prepare(`SELECT nullifier_of_bet, order_type, expiration FROM limit_orders WHERE nullifier_of_bet = ?`)
    .get(nullifier_of_bet) as { nullifier_of_bet: string; order_type: string; expiration: number } | undefined;
  if (!row) return null;
  const order_type: LimitOrderType =
    row.order_type === "GTD" ? "GTD" : row.order_type === "FAK" ? "FAK" : "GTC";
  return {
    nullifier_of_bet: row.nullifier_of_bet,
    order_type,
    expiration: row.expiration,
  };
}
