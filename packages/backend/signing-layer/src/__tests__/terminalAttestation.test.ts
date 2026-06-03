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

  it("matched → FILLED (0,0)", async () => {
    await run("matched", 0n, 0n);
    expect(store.__calls).toEqual([{ reportType: ReportType.FILLED, amountA: 0n, amountB: 0n }]);
  });

  it("filled (alias) → FILLED (0,0)", async () => {
    await run("filled", 0n, 0n);
    expect(store.__calls[0].reportType).toBe(ReportType.FILLED);
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
});
