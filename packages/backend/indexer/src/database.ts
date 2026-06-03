import Database from "better-sqlite3";
import path from "path";

export interface SettlementRecord {
  market_id: string;
  condition_id: string;
  position_id: string;
  payout_per_share: number; // scaled by 1e6, pUSD micro-units
  block_number: number;
  outcome: number; // 0=NO, 1=YES, -1=N/A
  created_at: number; // unix seconds
  // unix seconds when Vault.resolveMarket confirmed. Unknown at CTF-resolution insert
  // time (set later by setResolvedAt from the Vault listener), so optional on insert;
  // rows read back from the DB always carry it (column is NOT NULL DEFAULT 0).
  resolved_at?: number;
}

let db: Database.Database;

export function openDatabase(dbPath: string): void {
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS settlements (
      market_id   TEXT    PRIMARY KEY,
      condition_id TEXT   NOT NULL,
      position_id  TEXT   NOT NULL,
      payout_per_share INTEGER NOT NULL,
      block_number     INTEGER NOT NULL,
      outcome          INTEGER NOT NULL,
      created_at       INTEGER NOT NULL,
      resolved_at      INTEGER NOT NULL DEFAULT 0
    )
  `);
  try {
    db.exec(`ALTER TABLE settlements ADD COLUMN resolved_at INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // column already exists
  }
}

export function setResolvedAt(marketId: string, resolvedAt: number): void {
  db.prepare("UPDATE settlements SET resolved_at = ? WHERE market_id = ?").run(resolvedAt, marketId);
}

export function upsertSettlement(record: SettlementRecord): void {
  db
    .prepare(
      `INSERT OR REPLACE INTO settlements
       (market_id, condition_id, position_id, payout_per_share, block_number, outcome, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.market_id,
      record.condition_id,
      record.position_id,
      record.payout_per_share,
      record.block_number,
      record.outcome,
      record.created_at,
      record.resolved_at ?? 0
    );
}

export function getSettlement(marketId: string): SettlementRecord | undefined {
  return db
    .prepare("SELECT * FROM settlements WHERE market_id = ?")
    .get(marketId) as SettlementRecord | undefined;
}
