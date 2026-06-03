// Tests for submitFOKOrder against the mock-CLOB fetch path (the path pnpm dev:mock
// exercises). Covers Option-3 JIT funding + FC-9 terminal-state attestation. The CLOB
// fetch, ethers contracts, JIT funding, and the attestation store are mocked so no
// live network is needed.
// IMPORTANT: These tests must never use a real VAULT_EOA_PRIVATE_KEY or real USDC.

import { ethers } from "ethers";

// Prevent real env var reads. JIT funding reads pusdAddress + depositWalletAddress;
// the mocked pUSD balanceOf below returns a large balance so funding short-circuits
// via the residual-buffer path (no fundPolymarketWallet call).
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
    depositWalletAddress: "0x" + "e".repeat(40),
  },
}));

jest.mock("../circuitBreaker", () => ({
  checkResponse: jest.fn(),
  isHalted: jest.fn().mockReturnValue(false),
}));

// FC-9: terminal states sign + persist an OperatorAttestation instead of sending an
// on-chain report* tx. The store is single-write/idempotent; we mock it to assert the
// (reportType, amountA, amountB) mapping and the single-write invariant.
const ReportType = { FILLED: 1, FAILED: 2, PARTIAL: 3, SOLD: 4 };
jest.mock("../attestationStore", () => {
  // Idempotent fake: first write per nullifier is recorded; later writes return the
  // existing row without "re-signing" (we count signTypedData-equivalent invocations).
  const rows = new Map<string, { reportType: number; amountA: bigint; amountB: bigint }>();
  const signCount = { n: 0 };
  return {
    ReportType: { FILLED: 1, FAILED: 2, PARTIAL: 3, SOLD: 4 },
    getAttestationDomainParams: jest.fn(() => ({ chainId: 31337, verifyingContract: "0x" + "b".repeat(40) })),
    markResting: jest.fn(),
    __rows: rows,
    __signCount: signCount,
    signAndStoreAttestation: jest.fn(
      async (
        _wallet: unknown,
        _domain: unknown,
        input: { nullifierOfBet: string; reportType: number; amountA: bigint; amountB: bigint },
      ) => {
        const existing = rows.get(input.nullifierOfBet);
        if (existing) {
          return {
            nullifierOfBet: input.nullifierOfBet,
            reportType: existing.reportType,
            amountA: existing.amountA.toString(),
            amountB: existing.amountB.toString(),
            signature: "0xsig",
          };
        }
        signCount.n += 1; // a real sign happened
        rows.set(input.nullifierOfBet, { reportType: input.reportType, amountA: input.amountA, amountB: input.amountB });
        return {
          nullifierOfBet: input.nullifierOfBet,
          reportType: input.reportType,
          amountA: input.amountA.toString(),
          amountB: input.amountB.toString(),
          signature: "0xsig",
        };
      },
    ),
  };
});

const event = {
  nullifier: "0x" + "1".repeat(64),
  market_id: "0x" + "2".repeat(64),
  position_id: "0x" + "3".repeat(64),
  expected_shares: 200_000_000n,
  bet_amount: 100_000_000n, // $100 USDC
  price: 50_000_000n, // 50 cents
  new_commitment: "0x" + "4".repeat(64),
};

describe("submitFOKOrder (mock CLOB path)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let attestationStore: any;
  let fokStatus: string;
  let lastOrderBody: Record<string, unknown> | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.POLY_API_URL = "http://localhost:3001"; // forces mock-mode fetch path
    lastOrderBody = undefined;

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    attestationStore = require("../attestationStore");
    attestationStore.__rows.clear();
    attestationStore.__signCount.n = 0;

    // balanceOf is consumed by JIT funding (deposit-wallet pUSD) — return a large value
    // so the residual buffer always covers the bet and funding short-circuits to success.
    jest.spyOn(ethers, "Contract").mockImplementation(() => ({
      balanceOf: jest.fn().mockResolvedValue(10_000_000_000n),
    }) as unknown as ethers.Contract);

    // Mock CLOB: POST /order → { status: fokStatus }.
    global.fetch = jest.fn(async (_url: string, init?: { method?: string; body?: string }) => {
      lastOrderBody = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: fokStatus === "matched", status: fokStatus, orderID: "0xorder1", transactTime: "t" }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
  });

  const run = async () => {
    const { submitFOKOrder } = await import("../orderBuilder");
    const wallet = { address: "0x1234" } as unknown as ethers.Wallet;
    const provider = {} as ethers.JsonRpcProvider;
    await submitFOKOrder(event, wallet, provider);
  };

  it("attests FILLED (1) with zero amounts when order status is matched", async () => {
    fokStatus = "matched";
    await run();
    expect(attestationStore.signAndStoreAttestation).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { nullifierOfBet: event.nullifier, reportType: ReportType.FILLED, amountA: 0n, amountB: 0n },
    );
  });

  it("attests FAILED (2) with zero amounts when order is not filled", async () => {
    fokStatus = "unmatched";
    await run();
    expect(attestationStore.signAndStoreAttestation).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { nullifierOfBet: event.nullifier, reportType: ReportType.FAILED, amountA: 0n, amountB: 0n },
    );
  });

  it("single-write: a second matched run for the same bet does not re-sign", async () => {
    fokStatus = "matched";
    await run();
    await run();
    // signAndStoreAttestation is called twice, but the store only "signs" once.
    expect(attestationStore.signAndStoreAttestation).toHaveBeenCalledTimes(2);
    expect(attestationStore.__signCount.n).toBe(1);
  });

  it("order type is always FOK", async () => {
    fokStatus = "matched";
    await run();
    expect(lastOrderBody?.orderType).toBe("FOK");
  });

  it("does not submit order when circuit breaker is halted", async () => {
    const { isHalted } = require("../circuitBreaker");
    isHalted.mockReturnValue(true);
    await run();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(attestationStore.signAndStoreAttestation).not.toHaveBeenCalled();
  });
});
