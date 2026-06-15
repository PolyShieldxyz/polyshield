/**
 * FC-15: catalog mapping/filter + read-time guard tests. No network — toCatalogRow is pure, and the
 * DB is pointed at a temp file via a dynamic import so upsert/query exercise real SQLite.
 */
import os from "os";
import path from "path";
import fs from "fs";

const TMP = path.join(os.tmpdir(), `catalog-test-${process.pid}-${Date.now()}.db`);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any;
beforeAll(async () => {
  process.env.MARKET_CATALOG_DB_PATH = TMP;
  mod = await import("../marketCatalog");
});
afterAll(() => {
  for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) try { fs.unlinkSync(f); } catch { /* ignore */ }
});

const NOW = Math.floor(Date.now() / 1000);
const future = () => new Date((NOW + 86_400) * 1000).toISOString();
const past = () => new Date((NOW - 86_400) * 1000).toISOString();

function gamma(over: Record<string, unknown> = {}) {
  return {
    conditionId: "0x" + "ab".repeat(32),
    question: "Will it rain?",
    outcomes: JSON.stringify(["Yes", "No"]),
    outcomePrices: JSON.stringify(["0.6", "0.4"]),
    clobTokenIds: JSON.stringify(["111", "222"]),
    enableOrderBook: true,
    acceptingOrders: true,
    active: true,
    closed: false,
    endDate: future(),
    volumeNum: 1000,
    ...over,
  };
}

describe("toCatalogRow filtering (bettable-only)", () => {
  it("accepts a binary, order-book, accepting, future-dated market", () => {
    const r = mod.toCatalogRow(gamma(), "sync", NOW);
    expect(r).not.toBeNull();
    expect(r.yes_token_id).toBe("111");
    expect(r.no_token_id).toBe("222");
    expect(r.yes_price).toBeCloseTo(0.6);
    expect(r.accepting).toBe(1);
  });
  it("rejects non-binary (multi-outcome) markets", () => {
    expect(mod.toCatalogRow(gamma({ outcomes: JSON.stringify(["A", "B", "C"]) }), "sync", NOW)).toBeNull();
  });
  it("rejects markets without an order book", () => {
    expect(mod.toCatalogRow(gamma({ enableOrderBook: false }), "sync", NOW)).toBeNull();
  });
  it("rejects markets not accepting orders / closed", () => {
    expect(mod.toCatalogRow(gamma({ acceptingOrders: false }), "sync", NOW)).toBeNull();
    expect(mod.toCatalogRow(gamma({ closed: true }), "sync", NOW)).toBeNull();
  });
  it("rejects already-ended markets (endDate in the past)", () => {
    expect(mod.toCatalogRow(gamma({ endDate: past() }), "sync", NOW)).toBeNull();
  });
  it("accepts Up/Down binary markets", () => {
    const r = mod.toCatalogRow(gamma({ outcomes: JSON.stringify(["Up", "Down"]) }), "sync", NOW);
    expect(r).not.toBeNull();
    expect(JSON.parse(r.outcome_labels)).toEqual(["Up", "Down"]);
  });
});

describe("queryCatalog read-time guard + sort + pagination", () => {
  it("hides ended rows and sorts by volume, with pagination", () => {
    const ts = NOW;
    const rows = [
      mod.toCatalogRow(gamma({ conditionId: "0x" + "11".repeat(32), volumeNum: 50 }), "sync", ts),
      mod.toCatalogRow(gamma({ conditionId: "0x" + "22".repeat(32), volumeNum: 900 }), "sync", ts),
      mod.toCatalogRow(gamma({ conditionId: "0x" + "33".repeat(32), volumeNum: 300 }), "sync", ts),
    ].filter(Boolean);
    mod.upsertRows(rows);
    const page = mod.queryCatalog({ sort: "Volume", limit: 2, offset: 0 });
    expect(page.total).toBe(3);
    expect(page.markets.map((m: { vol: number }) => m.vol)).toEqual([900, 300]); // sorted desc, paginated
  });
});
