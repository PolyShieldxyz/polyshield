// FC-4 / FC-9: tests for attestTerminal — the shared terminal-state → OperatorAttestation
// mapping used by submitFAKOrder and the websocket fill tracker. The attestation store is
// mocked so we assert the (reportType, amountA, amountB) mapping and the strict-partial
// guard without any DB or signing.

const ReportType = { FILLED: 1, FAILED: 2, PARTIAL: 3, SOLD: 4 };

jest.mock("../attestationStore", () => {
  const calls: { reportType: number; amountA: bigint; amountB: bigint }[] = [];
  return {
    ReportType: { FILLED: 1, FAILED: 2, PARTIAL: 3, SOLD: 4 },
    getAttestationDomainParams: jest.fn(() => ({ chainId: 31337, verifyingContract: "0x" + "b".repeat(40) })),
    __calls: calls,
    signAndStoreAttestation: jest.fn(async (_w: unknown, _d: unknown, input: { reportType: number; amountA: bigint; amountB: bigint }) => {
      calls.push({ reportType: input.reportType, amountA: input.amountA, amountB: input.amountB });
      return { ...input, nullifierOfBet: "0x", amountA: input.amountA.toString(), amountB: input.amountB.toString(), signature: "0xsig" };
    }),
  };
});

import { ethers } from "ethers";

// expected_shares = 200e6, bet_amount = 100e6.
const bet = { nullifier: "0x" + "1".repeat(64), expected_shares: 200_000_000n, bet_amount: 100_000_000n };
const wallet = { address: "0x1234" } as unknown as ethers.Wallet;

describe("attestTerminal mapping", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let store: any;
  beforeEach(() => {
    jest.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    store = require("../attestationStore");
    store.__calls.length = 0;
  });

  const run = async (status: string, filled: bigint, spent: bigint) => {
    const { attestTerminal } = await import("../terminalAttestation");
    await attestTerminal(wallet, bet, status, filled, spent);
  };

  // L3: classification is by the ACTUAL fill vs the committed expected_shares, not the status
  // string. A full fill (filled >= expected_shares − DUST) → FILLED (0,0).
  it("full fill (>= expected) → FILLED (0,0)", async () => {
    await run("matched", 200_000_000n, 100_000_000n);
    expect(store.__calls).toEqual([{ reportType: ReportType.FILLED, amountA: 0n, amountB: 0n }]);
  });

  it("full fill regardless of status string → FILLED", async () => {
    await run("filled", 200_000_000n, 100_000_000n);
    expect(store.__calls[0].reportType).toBe(ReportType.FILLED);
  });

  // L3: zero actual fill is FAILED even when the CLOB status says "matched" (e.g. a status-only
  // mapping would wrongly attest FILLED for a downsized/short FOK).
  it("matched status but ZERO fill → FAILED (L3)", async () => {
    await run("matched", 0n, 0n);
    expect(store.__calls[0].reportType).toBe(ReportType.FAILED);
  });

  it("strict partial → PARTIAL with filled/spent", async () => {
    await run("partial", 120_000_000n, 60_000_000n);
    expect(store.__calls).toEqual([{ reportType: ReportType.PARTIAL, amountA: 120_000_000n, amountB: 60_000_000n }]);
  });

  it("partial that consumed the whole position → FILLED (not PARTIAL)", async () => {
    await run("partial", 200_000_000n, 100_000_000n);
    expect(store.__calls).toEqual([{ reportType: ReportType.FILLED, amountA: 0n, amountB: 0n }]);
  });

  it("partial with zero fill (degenerate) → FAILED", async () => {
    await run("partial", 0n, 0n);
    expect(store.__calls[0].reportType).toBe(ReportType.FAILED);
  });

  it("cancelled → FAILED", async () => {
    await run("cancelled", 0n, 0n);
    expect(store.__calls[0].reportType).toBe(ReportType.FAILED);
  });

  it("unmatched → FAILED", async () => {
    await run("unmatched", 0n, 0n);
    expect(store.__calls[0].reportType).toBe(ReportType.FAILED);
  });

  // L3: a fill within DUST (0.01 share = 1e4) of expected_shares is treated as a full fill, so a
  // sub-share tick/rounding difference doesn't force a needless PARTIAL.
  it("fill within DUST of expected → FILLED", async () => {
    await run("matched", 199_995_000n, 100_000_000n); // expected − 5_000 (< DUST)
    expect(store.__calls).toEqual([{ reportType: ReportType.FILLED, amountA: 0n, amountB: 0n }]);
  });

  // L3 (the core FOK divergence case): a "matched" FOK that budgetedBuyOrder downsized below the
  // committed expected_shares (beyond DUST) must attest PARTIAL, not FILLED.
  it("matched but downsized beyond DUST → PARTIAL", async () => {
    await run("matched", 180_000_000n, 90_000_000n); // 180e6 << 200e6
    expect(store.__calls).toEqual([{ reportType: ReportType.PARTIAL, amountA: 180_000_000n, amountB: 90_000_000n }]);
  });

  // L3 (B-relax): a short fill that spent the WHOLE budget (spent == bet, filled < expected) still
  // attests PARTIAL — amountB clamps to bet_amount; the Vault accepts spent == bet (refund 0).
  it("short fill, full budget spent (spent == bet) → PARTIAL amountB == bet", async () => {
    await run("matched", 120_000_000n, 100_000_000n); // spent == bet_amount
    expect(store.__calls).toEqual([{ reportType: ReportType.PARTIAL, amountA: 120_000_000n, amountB: 100_000_000n }]);
  });

  // spent over-reported above bet_amount is clamped to bet_amount (pool-safe; the Vault would also
  // reject spent > bet).
  it("short fill, spent over-reported > bet → clamped to bet", async () => {
    await run("matched", 120_000_000n, 150_000_000n); // spent > bet_amount
    expect(store.__calls).toEqual([{ reportType: ReportType.PARTIAL, amountA: 120_000_000n, amountB: 100_000_000n }]);
  });
});
