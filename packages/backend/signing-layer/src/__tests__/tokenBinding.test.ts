// Token-binding policy: the traded token must be derived from (market_id, outcome_side), never from the
// user-chosen on-chain position_id (see tokenBinding.ts). Regression tests for the "unbound market/position" issue.

import { decideBuyToken, decideCloseToken, isMockClobHost, UnboundTokenError } from "../tokenBinding";

const MARKET = "0x" + "11".repeat(32);
const ATTACKER_POSITION = "0x" + "99".repeat(32);   // user-chosen token of some OTHER market
const REG = { tokenId: "REAL_YES_TOKEN", conditionId: "0x" + "22".repeat(32) };

describe("decideBuyToken", () => {
  it("registry hit: trades the registry token and IGNORES the user-supplied position_id", () => {
    const d = decideBuyToken({ marketId: MARKET, positionId: ATTACKER_POSITION, outcomeSide: 0, resolved: REG, mock: false });
    expect(d).toEqual({ action: "trade", tokenId: "REAL_YES_TOKEN", conditionId: REG.conditionId, source: "registry" });
  });

  it("PRODUCTION registry miss: fail closed (this is the exploit path — must never trade position_id)", () => {
    const d = decideBuyToken({ marketId: MARKET, positionId: ATTACKER_POSITION, outcomeSide: 1, resolved: null, mock: false });
    expect(d).toEqual({ action: "reject", reason: "market_not_in_registry" });
  });

  it("registry row with an empty tokenId counts as a miss", () => {
    const d = decideBuyToken({ marketId: MARKET, positionId: ATTACKER_POSITION, outcomeSide: 0, resolved: { tokenId: "", conditionId: "x" }, mock: false });
    expect(d.action).toBe("reject");
  });

  it.each([2, 3, 255, -1, 1.5, NaN])("outcome_side %p is rejected even on a registry hit", (side) => {
    const d = decideBuyToken({ marketId: MARKET, positionId: ATTACKER_POSITION, outcomeSide: side, resolved: REG, mock: false });
    expect(d).toEqual({ action: "reject", reason: "outcome_side_out_of_range" });
  });

  it("mock CLOB only: falls back to the synthetic on-chain ids (local dev)", () => {
    const d = decideBuyToken({ marketId: MARKET, positionId: "0xsynthetic", outcomeSide: 0, resolved: null, mock: true });
    expect(d).toEqual({ action: "trade", tokenId: "0xsynthetic", conditionId: MARKET, source: "mock-onchain" });
  });

  it("mock mode does not weaken the outcome_side bound", () => {
    expect(decideBuyToken({ marketId: MARKET, positionId: "0xs", outcomeSide: 7, resolved: null, mock: true }).action).toBe("reject");
  });
});

describe("decideCloseToken", () => {
  it("registry hit: sells the registry token, ignoring the request position_id", () => {
    expect(decideCloseToken({ requestPositionId: ATTACKER_POSITION, outcomeSide: 0, resolved: REG, mock: false }))
      .toEqual({ tokenId: "REAL_YES_TOKEN", conditionId: REG.conditionId });
  });

  it("PRODUCTION registry miss: throws instead of selling a user-chosen token (pooled CTF balances!)", () => {
    expect(() => decideCloseToken({ requestPositionId: ATTACKER_POSITION, outcomeSide: 0, resolved: null, mock: false })).toThrow(UnboundTokenError);
  });

  it("unresolvable bet record (outcome_side unknown) in production throws", () => {
    expect(() => decideCloseToken({ requestPositionId: ATTACKER_POSITION, outcomeSide: null, resolved: null, mock: false })).toThrow(UnboundTokenError);
  });

  it("outcome_side out of range throws even when the registry has a row", () => {
    expect(() => decideCloseToken({ requestPositionId: "x", outcomeSide: 2, resolved: REG, mock: false })).toThrow(UnboundTokenError);
  });

  it("mock CLOB: uses the request position_id", () => {
    expect(decideCloseToken({ requestPositionId: "0xsynthetic", outcomeSide: null, resolved: null, mock: true }))
      .toEqual({ tokenId: "0xsynthetic", conditionId: "" });
  });
});

describe("isMockClobHost", () => {
  it("only local hosts are mock; the default (production CLOB) is not", () => {
    expect(isMockClobHost(undefined)).toBe(false);
    expect(isMockClobHost("https://clob.polymarket.com")).toBe(false);
    expect(isMockClobHost("http://localhost:3001")).toBe(true);
    expect(isMockClobHost("http://127.0.0.1:3001")).toBe(true);
  });
});
