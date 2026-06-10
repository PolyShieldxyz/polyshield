/**
 * tracked_markets — the set of markets the vault has placed bets on, persisted locally so the
 * settlement poll never needs a historical `eth_getLogs` over BetAuthorized (which a PRUNED RPC like
 * publicnode refuses with "History has been pruned for this block"). Each bet writes its market here
 * at submission time (eventListener.processBetEvent), when the BetAuthorized log is still recent and
 * readable. The settlement poll then iterates THIS table and checks resolution via the CTF
 * `payoutDenominator` STATE read (which pruned nodes serve fine) — no log scan, ever.
 *
 * Trade-off vs an archive RPC: this fixes the resolve/settle path on a pruned node, but does NOT fix
 * the collateral-redemption path (which still scans BetAuthorized for position ids) — see
 * redemptionPipeline. resolveMarket runs first (best-effort decoupling), so users can still settle.
 */

import Database from "better-sqlite3";
import path from "path";
import pino from "pino";

const logger = pino({ name: "tracked-markets" });
const DB_PATH = process.env.SETTLEMENT_DB_PATH ?? path.join(process.cwd(), "settlement.db");

let _db: Database.Database | null = null;
function db(): Database.Database {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS tracked_markets (
      reduced_key      TEXT PRIMARY KEY,  -- toFieldSafe(conditionId): on-chain market_id / circuit_key
      raw_condition_id TEXT NOT NULL,     -- real CTF conditionId for payoutDenominator / resolveMarket
      end_date         INTEGER,           -- unix seconds; market can't resolve before this. null = unknown
      created_at       INTEGER NOT NULL
    )
  `);
  return _db;
}

export interface TrackedMarket {
  reducedKey: string;
  rawConditionId: string;
  endDate: number | null;
}

/**
 * Record a market the vault has a bet on. Idempotent. Updates the raw conditionId and end_date when
 * better data arrives (e.g. a first write fell back to the reduced key because the registry hadn't
 * synced yet, and a later write has the real conditionId).
 */
export function upsertTrackedMarket(reducedKey: string, rawConditionId: string, endDate?: number | null): void {
  const key = reducedKey.toLowerCase();
  const raw = rawConditionId.toLowerCase();
  db()
    .prepare(
      `INSERT INTO tracked_markets (reduced_key, raw_condition_id, end_date, created_at)
       VALUES (@key, @raw, @endDate, @ts)
       ON CONFLICT(reduced_key) DO UPDATE SET
         raw_condition_id = excluded.raw_condition_id,
         end_date         = COALESCE(excluded.end_date, tracked_markets.end_date)`,
    )
    .run({ key, raw, endDate: endDate ?? null, ts: Math.floor(Date.now() / 1000) });
  logger.debug({ reducedKey: key, rawConditionId: raw, endDate: endDate ?? null }, "tracked market upserted");
}

export function getTrackedMarkets(): TrackedMarket[] {
  const rows = db()
    .prepare(`SELECT reduced_key, raw_condition_id, end_date FROM tracked_markets`)
    .all() as Array<{ reduced_key: string; raw_condition_id: string; end_date: number | null }>;
  return rows.map((r) => ({ reducedKey: r.reduced_key, rawConditionId: r.raw_condition_id, endDate: r.end_date }));
}

export function trackedMarketCount(): number {
  const row = db().prepare(`SELECT COUNT(*) AS n FROM tracked_markets`).get() as { n: number };
  return row.n;
}
