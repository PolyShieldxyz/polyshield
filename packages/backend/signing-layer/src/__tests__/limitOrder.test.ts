// FC-4: tests for submitLimitOrder's terminal-state mapping against the mock CLOB.
// Exercises the mock-mode (localhost) path: POST /order → "live" → reportResting,
// then GET /order/:id terminal status → exactly one of reportFilled /
// reportPartialFill / reportFOKFailure. No live network; fetch + contract are mocked.

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
  },
}));

jest.mock("../circuitBreaker", () => ({
  checkResponse: jest.fn(),
  isHalted: jest.fn().mockReturnValue(false),
}));

// nonceManager.send just invokes the tx builder with a fixed nonce.
jest.mock("../nonceManager", () => ({
  signingLayerNonceManager: {
    send: jest.fn(async (_p: unknown, _w: unknown, fn: (n: number) => unknown) => fn(0)),
  },
}));

const event = {
  nullifier: "0x" + "1".repeat(64),
  market_id: "0x" + "2".repeat(64),
  position_id: "0x" + "3".repeat(64),
  expected_shares: 200_000_000n,
  bet_amount: 100_000_000n,
  price: 50_000_000n,
  new_commitment: "0x" + "4".repeat(64),
};

describe("submitLimitOrder terminal-state mapping", () => {
  let reportResting: jest.Mock;
  let reportFilled: jest.Mock;
  let reportPartialFill: jest.Mock;
  let reportFOKFailure: jest.Mock;
  let restingState: { status: string; filledShares: number; spentAmount: number };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.POLY_API_URL = "http://localhost:3001"; // forces mock-mode fetch path

    const wait = jest.fn().mockResolvedValue(undefined);
    reportResting = jest.fn().mockResolvedValue({ wait });
    reportFilled = jest.fn().mockResolvedValue({ wait });
    reportPartialFill = jest.fn().mockResolvedValue({ wait });
    reportFOKFailure = jest.fn().mockResolvedValue({ wait });

    jest.spyOn(ethers, "Contract").mockImplementation(() => ({
      reportResting,
      reportFilled,
      reportPartialFill,
      reportFOKFailure,
    }) as unknown as ethers.Contract);

    // fetch: POST /order → live + orderID; GET /order/:id → current restingState.
    global.fetch = jest.fn(async (url: string, init?: { method?: string }) => {
      const isPost = init?.method === "POST";
      if (isPost && url.endsWith("/order")) {
        return { ok: true, status: 200, json: async () => ({ success: true, status: "live", orderID: "0xorder1" }) } as unknown as Response;
      }
      // GET /order/:id
      return { ok: true, status: 200, json: async () => restingState } as unknown as Response;
    }) as unknown as typeof fetch;
  });

  const run = async () => {
    const { submitLimitOrder } = await import("../orderBuilder");
    const wallet = { address: "0x1234" } as unknown as ethers.Wallet;
    const provider = {} as ethers.JsonRpcProvider;
    await submitLimitOrder(event, { orderType: "GTC", expiration: 0 }, wallet, provider);
  };

  it("fully filled → reportResting then reportFilled", async () => {
    restingState = { status: "matched", filledShares: 200_000_000, spentAmount: 100_000_000 };
    await run();
    expect(reportResting).toHaveBeenCalledWith(event.nullifier, { nonce: 0 });
    expect(reportFilled).toHaveBeenCalledWith(event.nullifier, { nonce: 0 });
    expect(reportPartialFill).not.toHaveBeenCalled();
    expect(reportFOKFailure).not.toHaveBeenCalled();
  });

  it("partial then terminated → reportPartialFill with filled/spent", async () => {
    restingState = { status: "partial", filledShares: 120_000_000, spentAmount: 60_000_000 };
    await run();
    expect(reportResting).toHaveBeenCalled();
    expect(reportPartialFill).toHaveBeenCalledWith(event.nullifier, 120_000_000n, 60_000_000n, { nonce: 0 });
    expect(reportFilled).not.toHaveBeenCalled();
    expect(reportFOKFailure).not.toHaveBeenCalled();
  });

  it("zero filled (cancelled) → reportFOKFailure", async () => {
    restingState = { status: "cancelled", filledShares: 0, spentAmount: 0 };
    await run();
    expect(reportResting).toHaveBeenCalled();
    expect(reportFOKFailure).toHaveBeenCalledWith(event.nullifier, { nonce: 0 });
    expect(reportFilled).not.toHaveBeenCalled();
    expect(reportPartialFill).not.toHaveBeenCalled();
  });

  it("does not submit when circuit breaker is halted", async () => {
    const { isHalted } = require("../circuitBreaker");
    isHalted.mockReturnValue(true);
    await run();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(reportResting).not.toHaveBeenCalled();
  });
});
