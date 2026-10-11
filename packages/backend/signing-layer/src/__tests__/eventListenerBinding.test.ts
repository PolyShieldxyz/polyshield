// Wiring test for the "unbound market/position" fix: processBetEvent must derive the traded token from
// (market_id, outcome_side) via the registry and must NOT place an order from a user-chosen position_id.

const submitFAKOrder = jest.fn(async () => undefined);
const submitLimitOrder = jest.fn(async () => undefined);
const attestFailedFor = jest.fn(async () => undefined);
const resolveTokenMock = jest.fn();
const upsertTrackedMarket = jest.fn();

jest.mock("../orderBuilder", () => ({
  submitFAKOrder: (...a: unknown[]) => submitFAKOrder(...(a as [])),
  submitLimitOrder: (...a: unknown[]) => submitLimitOrder(...(a as [])),
  attestFailedFor: (...a: unknown[]) => attestFailedFor(...(a as [])),
}));
jest.mock("../limitOrderStore", () => ({ getLimitOrder: jest.fn(() => null) }));
jest.mock("../attestationStore", () => ({ getAttestation: jest.fn(() => null) }));
jest.mock("../wsFillTracker", () => ({ isOrderTracked: jest.fn(() => false) }));
jest.mock("../marketRegistry", () => ({ resolveToken: (...a: unknown[]) => resolveTokenMock(...a), marketMetaForKey: jest.fn(() => null) }));
jest.mock("../trackedMarkets", () => ({ upsertTrackedMarket: (...a: unknown[]) => upsertTrackedMarket(...a) }));
jest.mock("../vaultEventSource", () => ({ scanHead: jest.fn(), fetchBetAuthorized: jest.fn() }));
jest.mock("../config", () => ({ config: { vaultContractAddress: "0x" + "ab".repeat(20) } }));

import { ethers } from "ethers";
import { processBetEvent } from "../eventListener";

const NULLIFIER = "0x" + "01".repeat(32);
const MARKET = "0x" + "11".repeat(32);
const ATTACKER_POSITION = "0x" + "99".repeat(32);
const wallet = { address: "0x1234" } as unknown as ethers.Wallet;
const provider = {} as unknown as ethers.JsonRpcProvider;

const run = (side = 0) =>
  processBetEvent(NULLIFIER, MARKET, ATTACKER_POSITION, side, 1_000_000n, 500_000n, 50_000_000n, "0x" + "02".repeat(32), wallet, provider);

describe("processBetEvent token binding", () => {
  const OLD = process.env.POLY_API_URL;
  beforeEach(() => { jest.clearAllMocks(); delete process.env.POLY_API_URL; /* default = production CLOB */ });
  afterAll(() => { if (OLD === undefined) delete process.env.POLY_API_URL; else process.env.POLY_API_URL = OLD; });

  it("production + registry miss: NO order, FAILED attestation, market not tracked", async () => {
    resolveTokenMock.mockReturnValue(null);
    await run(0);
    expect(submitFAKOrder).not.toHaveBeenCalled();
    expect(submitLimitOrder).not.toHaveBeenCalled();
    expect(attestFailedFor).toHaveBeenCalledWith(wallet, NULLIFIER);
    expect(upsertTrackedMarket).not.toHaveBeenCalled();
  });

  it("production + registry throws: treated as a miss (fail closed)", async () => {
    resolveTokenMock.mockImplementation(() => { throw new Error("db down"); });
    await run(1);
    expect(submitFAKOrder).not.toHaveBeenCalled();
    expect(attestFailedFor).toHaveBeenCalledTimes(1);
  });

  it("production + registry hit: orders the REGISTRY token, never the user's position_id", async () => {
    resolveTokenMock.mockReturnValue({ tokenId: "REAL_NO_TOKEN", conditionId: "0x" + "22".repeat(32) });
    await run(1);
    expect(attestFailedFor).not.toHaveBeenCalled();
    expect(submitFAKOrder).toHaveBeenCalledTimes(1);
    const ev = (submitFAKOrder.mock.calls[0] as unknown[])[0] as { position_id: string; market_id: string };
    expect(ev.position_id).toBe("REAL_NO_TOKEN");
    expect(ev.position_id).not.toBe(ATTACKER_POSITION);
    expect(ev.market_id).toBe("0x" + "22".repeat(32));
  });

  it("outcome_side > 1 is rejected even when the registry has the market", async () => {
    resolveTokenMock.mockReturnValue({ tokenId: "REAL_NO_TOKEN", conditionId: "0x" + "22".repeat(32) });
    await run(2);
    expect(submitFAKOrder).not.toHaveBeenCalled();
    expect(attestFailedFor).toHaveBeenCalledTimes(1);
  });

  it("mock CLOB (local dev): synthetic on-chain ids still work", async () => {
    process.env.POLY_API_URL = "http://localhost:3001";
    resolveTokenMock.mockReturnValue(null);
    await run(0);
    expect(attestFailedFor).not.toHaveBeenCalled();
    const ev = (submitFAKOrder.mock.calls[0] as unknown[])[0] as { position_id: string };
    expect(ev.position_id).toBe(ATTACKER_POSITION);
  });
});
