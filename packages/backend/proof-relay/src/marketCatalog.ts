/**
 * FC-15: public market CATALOG for the markets browsing page.
 *
 * The frontend used to fetch a tiny (~88) uncached batch from Gamma per request, leaking resolved
 * markets and refreshing janky. Instead, the proof-relay mirrors a LARGE active+bettable slice of the
 * Polymarket universe into SQLite (synced ~10 min), and serves it paginated/sortable/searchable with
 * no per-request Gamma load. Live search (Gamma `public-search`) upserts long-tail markets on demand.
 *
 * PUBLIC, anonymous data only — same trust posture as the rest of proof-relay (no secrets, no PII).
 * Filtering: only binary (Yes/No or Up/Down) order-book markets that are accepting orders and not yet
 * ended are stored AND re-checked at read time, so a market that resolves between syncs never shows.
 */

import Database from "better-sqlite3";
import path from "path";
import pino from "pino";

const logger = pino({ name: "market-catalog" });

const GAMMA = process.env.GAMMA_API_URL ?? "https://gamma-api.polymarket.com";
const CLOB = process.env.POLY_API_URL ?? "https://clob.polymarket.com";
const DB_PATH = process.env.MARKET_CATALOG_DB_PATH ?? path.join(process.cwd(), "catalog.db");

// MUST match the frontend's toFieldSafe (lib/notes.ts) and the signing-layer registry key.
const BN254_P = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;
function toFieldSafe(hex: string): string {
  return "0x" + (BigInt(hex) % BN254_P).toString(16).padStart(64, "0");
}

let _db: Database.Database | null = null;
function db(): Database.Database {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS market_catalog (
      condition_id    TEXT PRIMARY KEY,   -- real Polymarket conditionId (bytes32)
      field_safe_id   TEXT NOT NULL,      -- toFieldSafe(conditionId) = on-chain market_id
      question        TEXT NOT NULL,
      slug            TEXT,
      category        TEXT NOT NULL,
      tags            TEXT,               -- JSON array of tag slugs/labels (for search)
      yes_token_id    TEXT NOT NULL,
      no_token_id     TEXT NOT NULL,
      outcome_labels  TEXT,               -- JSON ["Yes","No"] / ["Up","Down"]
      volume          REAL DEFAULT 0,
      liquidity       REAL DEFAULT 0,
      day_change      REAL DEFAULT 0,
      end_date        INTEGER,            -- unix seconds (null if unknown)
      accepting       INTEGER DEFAULT 1,  -- accepting_orders (0/1)
      yes_price       REAL DEFAULT 0.5,
      description     TEXT,
      source          TEXT DEFAULT 'sync',-- 'sync' (bulk) | 'search' (live-searched upsert)
      updated_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_catalog_vol  ON market_catalog(volume);
    CREATE INDEX IF NOT EXISTS idx_catalog_end  ON market_catalog(end_date);
    CREATE INDEX IF NOT EXISTS idx_catalog_cat  ON market_catalog(category);
  `);
  return _db;
}

// ── Gamma → catalog mapping (ported from frontend lib/polymarket.ts) ──────────
type GammaTag = { label?: string; slug?: string };
type GammaMarket = {
  conditionId?: string;
  question?: string;
  slug?: string;
  description?: string;
  category?: string | null;
  tags?: GammaTag[];
  outcomes?: string;
  outcomePrices?: string;
  clobTokenIds?: string;
  volumeNum?: number;
  liquidityNum?: number;
  endDate?: string | null;
  oneDayPriceChange?: number;
  enableOrderBook?: boolean;
  acceptingOrders?: boolean;
  active?: boolean;
  closed?: boolean;
};

const TAG_BUCKETS: Array<[RegExp, string]> = [
  [/crypto|bitcoin|ethereum|solana|memecoin|defi|\bbtc\b|\beth\b|\bxrp\b|dogecoin/, "CRYPTO"],
  [/geopolit|iran|israel|russia|ukraine|china|taiwan|\bwar\b|middle.?east|nato|gaza/, "GEO"],
  [/econ|\bfed\b|interest.?rate|inflation|recession|\bgdp\b|\bcpi\b|jobs|macro/, "MACRO"],
  [/\bai\b|artificial|technology|\btech\b|science|space|software|openai/, "TECH"],
  [/sport|soccer|football|\bnfl\b|\bnba\b|\bmlb\b|fifa|tennis|\bufc\b|\bf1\b|hockey|baseball|basketball|golf/, "SPORTS"],
  [/politic|election|trump|biden|congress|senate|president|\bgov\b|democrat|republican/, "POLITICS"],
  [/culture|entertain|movie|music|award|celebr|\btv\b|oscar|grammy|\bpop\b/, "CULTURE"],
];
function categoryFromTags(tags: GammaTag[] | undefined, fallback: string | null | undefined): string {
  for (const t of tags ?? []) {
    const s = `${t.slug ?? ""} ${t.label ?? ""}`.toLowerCase();
    for (const [re, bucket] of TAG_BUCKETS) if (re.test(s)) return bucket;
  }
  return (fallback || "OTHER").toUpperCase();
}
const BINARY_PAIRS: ReadonlyArray<readonly [string, string]> = [["yes", "no"], ["up", "down"]];
/**
 * Any exactly-two-outcome market is bettable-binary. Prefer canonical Yes/No (or Up/Down)
 * ordering when present; otherwise it's a head-to-head (team A vs team B, candidate A vs B,
 * esports matches, etc.) — keep the native outcome order and surface the real labels.
 * `raw` is the original (un-lowercased) outcome array, used for display labels.
 */
function binaryIndices(lc: string[], raw: string[]): { yesIdx: number; noIdx: number; labels: [string, string] } | null {
  if (lc.length !== 2) return null;
  for (const [a, b] of BINARY_PAIRS) {
    const yesIdx = lc.indexOf(a);
    const noIdx = lc.indexOf(b);
    if (yesIdx >= 0 && noIdx >= 0) return { yesIdx, noIdx, labels: [a === "yes" ? "Yes" : "Up", b === "no" ? "No" : "Down"] };
  }
  return { yesIdx: 0, noIdx: 1, labels: [raw[0] ?? "Outcome A", raw[1] ?? "Outcome B"] };
}
function parseJsonArray(s: string | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

type CatalogRow = {
  condition_id: string;
  field_safe_id: string;
  question: string;
  slug: string | null;
  category: string;
  tags: string;
  yes_token_id: string;
  no_token_id: string;
  outcome_labels: string;
  volume: number;
  liquidity: number;
  day_change: number;
  end_date: number | null;
  accepting: number;
  yes_price: number;
  description: string | null;
  source: string;
  updated_at: number;
};

/** Map a Gamma market to a catalog row, or null if it isn't a bettable binary market. (exported for tests) */
export function toCatalogRow(m: GammaMarket, source: string, ts: number): CatalogRow | null {
  const cid = (m.conditionId ?? "").toLowerCase();
  if (!cid.startsWith("0x") || cid.length !== 66) return null;
  if (!m.enableOrderBook) return null;
  if (m.acceptingOrders === false || m.closed === true || m.active === false) return null;
  const rawOutcomes = parseJsonArray(m.outcomes);
  const outcomes = rawOutcomes.map((o) => o.toLowerCase());
  const bin = binaryIndices(outcomes, rawOutcomes);
  if (!bin) return null;
  const tokens = parseJsonArray(m.clobTokenIds);
  const yes = tokens[bin.yesIdx];
  const no = tokens[bin.noIdx];
  if (!yes || !no) return null;
  const endMs = m.endDate ? Date.parse(m.endDate) : NaN;
  const endSec = Number.isFinite(endMs) ? Math.floor(endMs / 1000) : null;
  // Exclude already-ended markets (resolved/closing) up front; read path re-checks too.
  if (endSec !== null && endSec <= Math.floor(ts)) return null;
  const prices = parseJsonArray(m.outcomePrices).map(Number);
  const yesPrice = Number.isFinite(prices[bin.yesIdx]) ? prices[bin.yesIdx] : 0.5;
  return {
    condition_id: cid,
    field_safe_id: toFieldSafe(cid),
    question: m.question ?? "Untitled market",
    slug: m.slug ?? null,
    category: categoryFromTags(m.tags, m.category),
    tags: JSON.stringify((m.tags ?? []).map((t) => t.slug ?? t.label ?? "").filter(Boolean)),
    yes_token_id: yes,
    no_token_id: no,
    outcome_labels: JSON.stringify(bin.labels),
    volume: m.volumeNum ?? 0,
    liquidity: m.liquidityNum ?? 0,
    day_change: typeof m.oneDayPriceChange === "number" ? m.oneDayPriceChange : 0,
    end_date: endSec,
    accepting: 1, // acceptingOrders === false already rejected above
    yes_price: yesPrice,
    description: m.description ?? null,
    source,
    updated_at: Math.floor(ts),
  };
}

export function upsertRows(rows: CatalogRow[]): number {
  const stmt = db().prepare(`
    INSERT INTO market_catalog (condition_id, field_safe_id, question, slug, category, tags, yes_token_id,
      no_token_id, outcome_labels, volume, liquidity, day_change, end_date, accepting, yes_price, description, source, updated_at)
    VALUES (@condition_id,@field_safe_id,@question,@slug,@category,@tags,@yes_token_id,@no_token_id,
      @outcome_labels,@volume,@liquidity,@day_change,@end_date,@accepting,@yes_price,@description,@source,@updated_at)
    ON CONFLICT(condition_id) DO UPDATE SET
      question=excluded.question, slug=excluded.slug, category=excluded.category, tags=excluded.tags,
      yes_token_id=excluded.yes_token_id, no_token_id=excluded.no_token_id, outcome_labels=excluded.outcome_labels,
      volume=excluded.volume, liquidity=excluded.liquidity, day_change=excluded.day_change, end_date=excluded.end_date,
      accepting=excluded.accepting, yes_price=excluded.yes_price, description=excluded.description, updated_at=excluded.updated_at
  `);
  const tx = db().transaction((items: CatalogRow[]) => {
    for (const r of items) stmt.run(r);
  });
  tx(rows);
  return rows.length;
}

async function fetchGamma(query: string): Promise<GammaMarket[]> {
  try {
    const res = await fetch(`${GAMMA}/markets?${query}&include_tag=true`);
    if (!res.ok) return [];
    const data = (await res.json()) as unknown;
    return Array.isArray(data) ? (data as GammaMarket[]) : [];
  } catch {
    return [];
  }
}

const PAGE = 500;
const MAX_PAGES = 20; // up to ~10k by volume — well above the active binary universe

async function syncPages(orderQuery: string, maxPages: number, ts: number): Promise<number> {
  let upserted = 0;
  for (let page = 0; page < maxPages; page++) {
    const data = await fetchGamma(`closed=false&active=true&archived=false&limit=${PAGE}&offset=${page * PAGE}&${orderQuery}`);
    if (data.length === 0) break;
    const rows = data.map((m) => toCatalogRow(m, "sync", ts)).filter((r): r is CatalogRow => r !== null);
    upserted += upsertRows(rows);
    if (data.length < PAGE) break;
  }
  return upserted;
}

/** Bulk sync: a deep volume pass + a soon-resolving pass (covers short-dated recurring markets). */
export async function syncCatalog(): Promise<number> {
  const ts = Date.now() / 1000;
  const byVol = await syncPages("order=volume24hr&ascending=false", MAX_PAGES, ts);
  const nowIso = new Date().toISOString();
  const bySoon = await syncPages(`order=endDate&ascending=true&end_date_min=${encodeURIComponent(nowIso)}`, 4, ts);
  // Drop rows that have since ended / stopped accepting so the catalog stays bettable-only.
  db().prepare(`DELETE FROM market_catalog WHERE accepting = 0 OR (end_date IS NOT NULL AND end_date <= ?)`).run(Math.floor(ts));
  logger.info({ byVol, bySoon, total: countCatalog() }, "market catalog sync complete");
  return byVol + bySoon;
}

// ── Read API (used by the /markets endpoints) ─────────────────────────────────
export type ClientMarket = {
  id: string;
  conditionId: string;
  cat: string;
  name: string;
  yes: number;
  delta: number;
  vol: number;
  liq: number;
  traders: number;
  resolves: string;
  endTs: number;
  trend: number[];
  desc?: string;
  yesTokenId?: string;
  noTokenId?: string;
  outcomeLabels?: [string, string];
  acceptingOrders?: boolean;
  source: "live";
};

function fmtDate(sec: number | null): string {
  if (!sec) return "—";
  return new Date(sec * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function toClient(r: CatalogRow): ClientMarket {
  let labels: [string, string] | undefined;
  try {
    const l = JSON.parse(r.outcome_labels);
    if (Array.isArray(l) && l.length === 2) labels = [String(l[0]), String(l[1])];
  } catch { /* ignore */ }
  return {
    id: r.condition_id,
    conditionId: r.condition_id,
    cat: r.category,
    name: r.question,
    yes: r.yes_price,
    delta: r.day_change,
    vol: r.volume,
    liq: r.liquidity,
    traders: 0,
    resolves: fmtDate(r.end_date),
    endTs: r.end_date ? r.end_date * 1000 : 0,
    trend: [r.yes_price, r.yes_price],
    desc: r.description ?? undefined,
    yesTokenId: r.yes_token_id,
    noTokenId: r.no_token_id,
    outcomeLabels: labels,
    acceptingOrders: r.accepting === 1,
    source: "live",
  };
}

const SORT_COLUMNS: Record<string, string> = {
  Volume: "volume DESC",
  Liquidity: "liquidity DESC",
  "Resolves soon": "(end_date IS NULL) ASC, end_date ASC",
  "Δ24h": "ABS(day_change) DESC",
};

/** Paginated/sorted/filtered read. Always excludes ended / not-accepting rows (read-time guard). */
export function queryCatalog(opts: {
  offset?: number;
  limit?: number;
  sort?: string;
  category?: string;
  q?: string;
}): { markets: ClientMarket[]; total: number } {
  const now = Math.floor(Date.now() / 1000);
  const where: string[] = ["accepting = 1", "(end_date IS NULL OR end_date > @now)"];
  const params: Record<string, unknown> = { now };
  if (opts.category && opts.category !== "ALL") {
    where.push("category = @category");
    params.category = opts.category.toUpperCase();
  }
  if (opts.q) {
    where.push("(LOWER(question) LIKE @q OR LOWER(tags) LIKE @q OR LOWER(slug) LIKE @q)");
    params.q = `%${opts.q.toLowerCase()}%`;
  }
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const orderSql = SORT_COLUMNS[opts.sort ?? "Volume"] ?? SORT_COLUMNS.Volume;
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const total = (db().prepare(`SELECT COUNT(*) AS n FROM market_catalog ${whereSql}`).get(params) as { n: number }).n;
  const rows = db()
    .prepare(`SELECT * FROM market_catalog ${whereSql} ORDER BY ${orderSql} LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit, offset }) as CatalogRow[];
  return { markets: rows.map(toClient), total };
}

export function getMarketByCondition(conditionId: string): ClientMarket | null {
  const row = db()
    .prepare(`SELECT * FROM market_catalog WHERE condition_id = ?`)
    .get(conditionId.toLowerCase()) as CatalogRow | undefined;
  return row ? toClient(row) : null;
}

/** Look a market up by its FIELD-SAFE id (conditionId % BN254_P) — the value that appears on-chain in
 * BetAuthorized/betRecords. Lets the portfolio resolve a name for a bet that only knows the field-safe
 * id (e.g. a chain-recovered note), as long as the market is still in the catalog. */
export function getMarketByFieldSafe(fieldSafeId: string): ClientMarket | null {
  const row = db()
    .prepare(`SELECT * FROM market_catalog WHERE field_safe_id = ?`)
    .get(fieldSafeId.toLowerCase()) as CatalogRow | undefined;
  return row ? toClient(row) : null;
}

export function countCatalog(): number {
  return (db().prepare(`SELECT COUNT(*) AS n FROM market_catalog`).get() as { n: number }).n;
}

/**
 * Resolve JUST the human-readable question for a conditionId — including CLOSED/ended markets that
 * are filtered out of the bettable catalog (so e.g. a portfolio's settled/expired bets still show a
 * name instead of a hex id). Checks the bettable catalog first, then asks Gamma directly with NO
 * bettable filter (a closed market still carries its `question`). Returns null if Gamma has nothing.
 */
export async function resolveMarketName(conditionId: string): Promise<string | null> {
  const cid = conditionId.toLowerCase();
  const cached = getMarketByCondition(cid);
  if (cached) return cached.name;
  // The id might be a FIELD-SAFE on-chain id rather than a real conditionId (e.g. a chain-recovered
  // bet) — resolve it from the catalog while the market is still listed. (Closed markets are purged,
  // and Gamma can't be queried by a field-safe id, so a settled bet known only by field-safe id can't
  // be resolved — its name must come from what was stored at bet time.)
  const byField = getMarketByFieldSafe(cid);
  if (byField) return byField.name;
  const pick = (data: GammaMarket[]): string | null => {
    const q = data.find((m) => (m.conditionId ?? "").toLowerCase() === cid)?.question;
    return q && q.trim() ? q : null;
  };
  try {
    // Open markets come back from the default query; CLOSED/ended markets are omitted unless we
    // explicitly pass closed=true. Try open first, then closed, so either resolves.
    const name = pick(await fetchGamma(`condition_ids=${encodeURIComponent(cid)}`));
    if (name) return name;
    return pick(await fetchGamma(`condition_ids=${encodeURIComponent(cid)}&closed=true`));
  } catch {
    return null;
  }
}

/** Fetch a single market by conditionId from Gamma and upsert it (used on catalog miss). */
export async function ingestByConditionId(conditionId: string): Promise<ClientMarket | null> {
  const data = await fetchGamma(`condition_ids=${encodeURIComponent(conditionId)}`);
  const row = data.map((m) => toCatalogRow(m, "search", Date.now() / 1000)).find((r): r is CatalogRow => r !== null);
  if (!row) return null;
  upsertRows([row]);
  return toClient(row);
}

// ── Live search (Gamma public-search → full market fetch → upsert) ─────────────
async function gammaPublicSearchConditionIds(q: string, cap: number): Promise<string[]> {
  try {
    const res = await fetch(`${GAMMA}/public-search?q=${encodeURIComponent(q)}&search_tags=false&search_profiles=false&limit_per_type=${cap}`);
    if (!res.ok) return [];
    const data = (await res.json()) as { events?: Array<{ markets?: Array<{ conditionId?: string }> }> };
    const ids = new Set<string>();
    for (const ev of data.events ?? []) {
      for (const m of ev.markets ?? []) {
        const cid = (m.conditionId ?? "").toLowerCase();
        if (cid.startsWith("0x") && cid.length === 66) ids.add(cid);
      }
    }
    return [...ids].slice(0, cap);
  } catch {
    return [];
  }
}

/**
 * Search: local catalog first; if too few hits, live-search Polymarket, fetch the full market data
 * for the hits, upsert into the shared catalog, and return merged results. `wentLive` lets the client
 * show its "Searching Polymarket…" affordance honestly.
 */
export async function searchMarkets(q: string, limit = 50): Promise<{ markets: ClientMarket[]; wentLive: boolean }> {
  const local = queryCatalog({ q, limit, sort: "Volume" });
  if (local.markets.length >= 5) return { markets: local.markets, wentLive: false };

  const ids = await gammaPublicSearchConditionIds(q, 25);
  if (ids.length === 0) return { markets: local.markets, wentLive: true };
  const ts = Date.now() / 1000;
  const fetched = await Promise.all(ids.map((id) => fetchGamma(`condition_ids=${encodeURIComponent(id)}`)));
  const rows = fetched.flat().map((m) => toCatalogRow(m, "search", ts)).filter((r): r is CatalogRow => r !== null);
  if (rows.length > 0) upsertRows(rows);
  // Re-query so live results merge with any local hits, de-duplicated and uniformly sorted.
  return { markets: queryCatalog({ q, limit, sort: "Volume" }).markets, wentLive: true };
}

// ── Odds overlay: live CLOB midpoints for the visible markets ─────────────────
/** Batch midpoints for token ids → { tokenId: midpointPrice }. Best-effort; missing tokens omitted. */
export async function fetchMidpoints(tokenIds: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await Promise.all(
    tokenIds.slice(0, 100).map(async (id) => {
      try {
        const res = await fetch(`${CLOB}/midpoint?token_id=${encodeURIComponent(id)}`);
        if (!res.ok) return;
        const data = (await res.json()) as { mid?: number | string };
        const mid = Number(data?.mid);
        if (Number.isFinite(mid)) out[id] = mid;
      } catch { /* omit on failure */ }
    }),
  );
  return out;
}

let _timer: NodeJS.Timeout | null = null;
/** Start the bulk catalog sync loop. Runs once immediately, then every intervalMs (~10 min). */
export function startMarketCatalogSync(intervalMs = 10 * 60 * 1000): void {
  if (process.env.MARKET_CATALOG_DISABLED === "true") {
    logger.warn("MARKET_CATALOG_DISABLED=true — catalog sync off (offline dev); /markets will be empty");
    return;
  }
  if (_timer) return;
  const run = () => syncCatalog().catch((err) => logger.error({ err: String(err) }, "catalog sync failed"));
  run();
  _timer = setInterval(run, intervalMs);
  logger.info({ intervalMs, dbPath: DB_PATH }, "market catalog sync started");
}
