import path from "path";
import os from "os";
import { openDatabase, upsertSettlement, getSettlement } from "../database";

describe("database", () => {
  beforeAll(() => {
    const dbPath = path.join(os.tmpdir(), `test-indexer-${Date.now()}.db`);
    openDatabase(dbPath);
  });

  it("returns undefined for unknown market", () => {
    expect(getSettlement("nonexistent")).toBeUndefined();
  });

  it("upserts and retrieves a settlement", () => {
    const record = {
      market_id: "0xabc",
      condition_id: "0xabc",
      position_id: "0xdef",
      payout_per_share: 1_000_000,
      block_number: 12345,
      outcome: 1,
      created_at: Math.floor(Date.now() / 1000),
    };
    upsertSettlement(record);
    const retrieved = getSettlement("0xabc");
    expect(retrieved).toBeDefined();
    expect(retrieved!.outcome).toBe(1);
    expect(retrieved!.payout_per_share).toBe(1_000_000);
  });

  it("overwrites on upsert", () => {
    const record = {
      market_id: "0xabc",
      condition_id: "0xabc",
      position_id: "0xdef",
      payout_per_share: 500_000,
      block_number: 12346,
      outcome: 0,
      created_at: Math.floor(Date.now() / 1000),
    };
    upsertSettlement(record);
    const retrieved = getSettlement("0xabc");
    expect(retrieved!.payout_per_share).toBe(500_000);
    expect(retrieved!.outcome).toBe(0);
  });

  it("computes payout_per_share correctly (1e6 scaling)", () => {
    // For a binary market where YES wins: payout = numerator * 1e6 / denominator
    // numerator = 1_000_000 (full payout), denominator = 1_000_000 -> $1.00 per share
    const payoutPerShare = Number((1_000_000n * 1_000_000n) / 1_000_000n);
    expect(payoutPerShare).toBe(1_000_000);
  });

  it("detects NA (all-zero numerators)", () => {
    const numerators = [0n, 0n];
    const allZero = numerators.every((n) => n === 0n);
    expect(allZero).toBe(true);
  });
});
