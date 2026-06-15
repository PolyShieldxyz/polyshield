/**
 * FC-15: anonymous analytics. The load-bearing test is the PRIVACY property — the store holds only
 * aggregate (scope,key,count) and NOTHING that could identify a user (no wallet/IP/id columns).
 */
import os from "os";
import path from "path";
import fs from "fs";
import Database from "better-sqlite3";

const TMP = path.join(os.tmpdir(), `analytics-test-${process.pid}-${Date.now()}.db`);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any;
beforeAll(async () => {
  process.env.ANALYTICS_DB_PATH = TMP;
  mod = await import("../analytics");
});
afterAll(() => {
  for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) try { fs.unlinkSync(f); } catch { /* ignore */ }
});

describe("anonymous analytics", () => {
  it("increments aggregate counters and rejects unknown scopes", () => {
    mod.recordEvents([
      { scope: "market_view", key: "0xabc" },
      { scope: "market_view", key: "0xabc" },
      { scope: "tag_click", key: "Crypto" },
      { scope: "evil_scope", key: "x" }, // unknown → dropped
    ]);
    const views = mod.topKeys("market_view");
    expect(views.find((r: { key: string }) => r.key === "0xabc")?.count).toBe(2);
    expect(mod.topKeys("tag_click").find((r: { key: string }) => r.key === "crypto")?.count).toBe(1); // lower-cased
    expect(mod.topKeys("evil_scope")).toHaveLength(0);
  });

  it("stores ONLY aggregate columns — no wallet/IP/id (privacy invariant)", () => {
    mod.recordEvents([{ scope: "search_query", key: "election" }]);
    const cols = new Database(TMP)
      .prepare(`PRAGMA table_info(analytics_counters)`)
      .all()
      .map((c: { name: string }) => c.name);
    expect(cols.sort()).toEqual(["count", "key", "scope"]);
    // No identifying columns of any kind.
    for (const forbidden of ["wallet", "address", "ip", "user", "session", "id"]) {
      expect(cols).not.toContain(forbidden);
    }
  });
});
