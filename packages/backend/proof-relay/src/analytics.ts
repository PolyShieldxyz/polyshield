/**
 * FC-15: ANONYMOUS, AGGREGATE engagement analytics for the beta.
 *
 * Records what markets/tags/sorts/searches users engage with so we can tune the catalog fetch.
 * PRIVACY (non-negotiable for this product): aggregate COUNTERS only — no wallet address, no IP, no
 * stable/session id, no per-user trail. Tying browsing to a wallet would be a deanonymization vector
 * (correlating "wallet viewed market M" with a later bet on M). We store strictly (scope, key) → count.
 */

import Database from "better-sqlite3";
import path from "path";

const DB_PATH = process.env.ANALYTICS_DB_PATH ?? path.join(process.cwd(), "analytics.db");

// Allowed event scopes — anything else is rejected (no free-form scopes → bounded table).
const SCOPES = new Set(["market_view", "tag_click", "sort_change", "category_click", "search_query", "search_live"]);

let _db: Database.Database | null = null;
function db(): Database.Database {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS analytics_counters (
      scope TEXT NOT NULL,
      key   TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (scope, key)
    )
  `);
  return _db;
}

/** Increment aggregate counters for a batch of {scope, key} events. Unknown scopes/oversized keys dropped. */
export function recordEvents(events: Array<{ scope: string; key: string }>): number {
  const stmt = db().prepare(`
    INSERT INTO analytics_counters (scope, key, count) VALUES (@scope, @key, 1)
    ON CONFLICT(scope, key) DO UPDATE SET count = count + 1
  `);
  let n = 0;
  const tx = db().transaction((items: Array<{ scope: string; key: string }>) => {
    for (const e of items) {
      if (!SCOPES.has(e.scope)) continue;
      const key = String(e.key ?? "").slice(0, 120).toLowerCase(); // bound key length; lower-case search terms
      if (!key) continue;
      stmt.run({ scope: e.scope, key });
      n++;
    }
  });
  tx(events.slice(0, 50)); // cap per request
  return n;
}

/** Top keys for a scope — for our own beta review (not exposed publicly by default). */
export function topKeys(scope: string, limit = 50): Array<{ key: string; count: number }> {
  return db()
    .prepare(`SELECT key, count FROM analytics_counters WHERE scope = ? ORDER BY count DESC LIMIT ?`)
    .all(scope, Math.min(limit, 500)) as Array<{ key: string; count: number }>;
}
