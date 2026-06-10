// FAK (fill-and-kill) order tests against the mock-CLOB fetch path (what pnpm dev:mock
// exercises). FAK is synchronous: its POST response carries the terminal status +
// filled/spent amounts, mapped onto one attestation (FILLED / PARTIAL / FAILED). The
// fill tracker is mocked out (FAK needs no websocket); the attestation store, JIT funding,
// and circuit breaker are mocked so no live network is needed.

import { ethers } from "ethers";

jest.mock("../config", () => ({
  config: {
    vaultEoaPrivateKey: "0x" + "a".repeat(64),
    polyApiKey: "test-key",
    polySecret: "test-secret",
    polyPassphrase: "test-pass",
    polygonRpcUrl: "http://localhost:8545",
    vaultContractAddress: "0x" + "b".repeat(40),
    signingLayerOperatorAddress: "0x" + "c".repeat(40),
    pusdAddress: "0x" + "d".repeat(40),
    usdcAddress: "0x" + "f".repeat(40),
    onrampAddress: "0x" + "a".repeat(40),
    depositWalletAddress: "0x" + "e".repeat(40),
    polyWsUrl: "ws://localhost:3001/ws/user",
  },
}));

jest.mock("../circuitBreaker", () => ({
  checkResponse: jest.fn(),
  isHalted: jest.fn().mockReturnValue(false),
}));

// FAK does not use the websocket tracker; mock it so importing orderBuilder doesn't pull
// in the real ws/sqlite tracker module.
jest.mock("../wsFillTracker", () => ({ trackOrder: jest.fn() }));

const ReportType = { FILLED: 1, FAILED: 2, PARTIAL: 3, SOLD: 4 };
jest.mock("../attestationStore", () => {
  const rows = new Map<string, { reportType: number; amountA: bigint; amountB: bigint }>();
  const signCount = { n: 0 };
  return {
    ReportType: { FILLED: 1, FAILED: 2, PARTIAL: 3, SOLD: 4 },
    getAttestationDomainParams: jest.fn(() => ({ chainId: 31337, verifyingContract: "0x" + "b".repeat(40) })),
    markResting: jest.fn(),
    __rows: rows,
    __signCount: signCount,
    signAndStoreAttestation: jest.fn(
      async (_w: unknown, _d: unknown, input: { nullifierOfBet: string; reportType: number; amountA: bigint; amountB: bigint }) => {
        const existing = rows.get(input.nullifierOfBet);
        if (existing) return { ...existing, nullifierOfBet: input.nullifierOfBet, signature: "0xsig" };
        signCount.n += 1;
        rows.set(input.nullifierOfBet, { reportType: input.reportType, amountA: input.amountA, amountB: input.amountB });
        return { nullifierOfBet: input.nullifierOfBet, reportType: input.reportType, amountA: input.amountA.toString(), amountB: input.amountB.toString(), signature: "0xsig" };
      },
    ),
  };
});

const event = {
  nullifier: "0x" + "1".repeat(64),
  market_id: "0x" + "2".repeat(64),
  position_id: "0x" + "3".repeat(64),
  expected_shares: 200_000_000n,
  bet_amount: 100_000_000n,
  price: 50_000_000n,
  new_commitment: "0x" + "4".repeat(64),
};

describe("submitFAKOrder (mock CLOB path)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let store: any;
  let resp: Record<string, unknown>;
  let lastBody: Record<string, unknown> | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.POLY_API_URL = "http://localhost:3001";
    lastBody = undefined;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    store = require("../attestationStore");
    store.__rows.clear();
    store.__signCount.n = 0;

    jest.spyOn(ethers, "Contract").mockImplementation(() => ({
      balanceOf: jest.fn().mockResolvedValue(10_000_000_000n),
    }) as unknown as ethers.Contract);

    global.fetch = jest.fn(async (_url: string, init?: { body?: string }) => {
      lastBody = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      return { ok: true, status: 200, json: async () => resp } as unknown as Response;
    }) as unknown as typeof fetch;
  });

  const run = async () => {
    const { submitFAKOrder } = await import("../orderBuilder");
    await submitFAKOrder(event, { address: "0x1234" } as unknown as ethers.Wallet, {} as ethers.JsonRpcProvider);
  };

  it("submits orderType FAK", async () => {
    resp = { success: true, status: "MATCHED", filledShares: 200_000_000, spentAmount: 100_000_000, orderID: "0xo" };
    await run();
    expect(lastBody?.orderType).toBe("FAK");
  });

  it("matched → FILLED (0,0)", async () => {
    resp = { success: true, status: "MATCHED", filledShares: 200_000_000, spentAmount: 100_000_000, orderID: "0xo" };
    await run();
    expect(store.signAndStoreAttestation).toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      { nullifierOfBet: event.nullifier, reportType: ReportType.FILLED, amountA: 0n, amountB: 0n },
    );
  });

  it("partial → PARTIAL with filled/spent", async () => {
    resp = { success: true, status: "PARTIAL", filledShares: 120_000_000, spentAmount: 60_000_000, orderID: "0xo" };
    await run();
    expect(store.signAndStoreAttestation).toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      { nullifierOfBet: event.nullifier, reportType: ReportType.PARTIAL, amountA: 120_000_000n, amountB: 60_000_000n },
    );
  });

  it("unmatched → FAILED (0,0)", async () => {
    resp = { success: false, status: "UNMATCHED", filledShares: 0, spentAmount: 0, orderID: "0xo" };
    await run();
    expect(store.signAndStoreAttestation).toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      { nullifierOfBet: event.nullifier, reportType: ReportType.FAILED, amountA: 0n, amountB: 0n },
    );
  });

  // BUG-1 regression: the REAL Polymarket CLOB returns matched amounts as decimal strings
  // (takingAmount = shares, makingAmount = USDC) — NOT filledShares/size_matched. Parsing must
  // pick those up; otherwise a real partial fill reads as 0 → FAILED → false full reclaim → loss.
  it("real-CLOB makingAmount/takingAmount partial → PARTIAL (not FAILED)", async () => {
    resp = { success: true, status: "matched", orderID: "0xo", takingAmount: "47.75", makingAmount: "3.3425" };
    await run();
    expect(store.signAndStoreAttestation).toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      { nullifierOfBet: event.nullifier, reportType: ReportType.PARTIAL, amountA: 47_750_000n, amountB: 3_342_500n },
    );
  });

  it("real-CLOB makingAmount/takingAmount full fill → FILLED", async () => {
    resp = { success: true, status: "matched", orderID: "0xo", takingAmount: "200", makingAmount: "100" };
    await run();
    expect(store.signAndStoreAttestation).toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      { nullifierOfBet: event.nullifier, reportType: ReportType.FILLED, amountA: 0n, amountB: 0n },
    );
  });

  it("single-write: a second matched run does not re-sign", async () => {
    resp = { success: true, status: "MATCHED", filledShares: 200_000_000, spentAmount: 100_000_000, orderID: "0xo" };
    await run();
    await run();
    expect(store.__signCount.n).toBe(1);
  });

  it("does not submit when circuit breaker is halted", async () => {
    const { isHalted } = require("../circuitBreaker");
    isHalted.mockReturnValue(true);
    resp = { success: true, status: "MATCHED" };
    await run();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(store.signAndStoreAttestation).not.toHaveBeenCalled();
  });
});

// Bug 2 (CLOB taker fee): the user pays Polymarket's fee out of their stake — it is GONE, never
// refunded. budgetedBuyOrder reserves the fee in the submitted size, so spent must record the whole
// stake on a full fill (refund 0) and only the unfilled remainder on a genuine partial.
describe("marketSpentWithFee (CLOB-fee-inclusive spent)", () => {
  const STAKE = 100_000_000n;     // $100 (1e6-scaled)
  const SIZED = 99_000_000n;      // 99 shares — fee-reserved size budgetedBuyOrder submitted

  it("full fill of the fee-reserved size → whole stake spent (refund 0)", async () => {
    const { marketSpentWithFee } = await import("../orderBuilder");
    expect(marketSpentWithFee(STAKE, SIZED, SIZED)).toBe(STAKE);
  });

  it("fill within dust of the submitted size → treated as full", async () => {
    const { marketSpentWithFee } = await import("../orderBuilder");
    expect(marketSpentWithFee(STAKE, SIZED - 5_000n, SIZED)).toBe(STAKE);
  });

  it("genuine partial → proportional spend (refunds only the unfilled stake, keeps the fee)", async () => {
    const { marketSpentWithFee } = await import("../orderBuilder");
    // Half the fee-reserved size filled → half the stake spent → half refunds.
    expect(marketSpentWithFee(STAKE, SIZED / 2n, SIZED)).toBe(STAKE / 2n);
  });

  it("never reports more than the stake", async () => {
    const { marketSpentWithFee } = await import("../orderBuilder");
    expect(marketSpentWithFee(STAKE, SIZED * 2n, SIZED)).toBe(STAKE);
  });
});
