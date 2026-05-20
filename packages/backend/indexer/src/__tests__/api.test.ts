import request from "supertest";
import path from "path";
import os from "os";
import { openDatabase, upsertSettlement } from "../database.js";
import { createApp } from "../api.js";

// supertest is a dev dependency; add it to indexer package.json if running tests
const supertest = require("supertest");

describe("indexer API", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    const dbPath = path.join(os.tmpdir(), `test-api-${Date.now()}.db`);
    openDatabase(dbPath);
    app = createApp();
  });

  it("GET /health returns 200", async () => {
    const res = await supertest(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("GET /settlement/:market_id returns 404 for unknown", async () => {
    const res = await supertest(app).get("/settlement/unknown");
    expect(res.status).toBe(404);
  });

  it("GET /settlement/:market_id returns correct JSON for known market", async () => {
    upsertSettlement({
      market_id: "0xtest",
      condition_id: "0xtest",
      position_id: "0xpos",
      payout_per_share: 750_000,
      block_number: 9999,
      outcome: 1,
      created_at: 1000000,
    });
    const res = await supertest(app).get("/settlement/0xtest");
    expect(res.status).toBe(200);
    expect(res.body.payout_per_share).toBe(750_000);
    expect(res.body.outcome).toBe(1);
    expect(res.body.block_number).toBe(9999);
  });
});
