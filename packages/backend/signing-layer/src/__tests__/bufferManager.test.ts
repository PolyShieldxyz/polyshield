// L2 (FC-6 / Option 4): tests for the proactive base-buffer manager. The pUSD balance read, the
// Vault.fundPolymarketWallet tx, the nonce manager, the shared funding mutex, and the deposit-wallet
// wrap are all mocked, so we assert the top-up decision (below low-water → fund to target; healthy →
// no-op; cap revert → caught, no crash) without any live network or signing.

import { ethers } from "ethers";

// 1e6-scaled USDC: low $10, target $30.
jest.mock("../config", () => ({
  config: {
    bufferLowWaterUsdc: 10_000_000n,
    bufferTargetUsdc: 30_000_000n,
    bufferHighWaterUsdc: 50_000_000n,
    bufferManagerPollMs: 10_000_000, // huge → the interval never fires during the test
    pusdAddress: "0x" + "d".repeat(40),
    depositWalletAddress: "0x" + "e".repeat(40),
    vaultContractAddress: "0x" + "b".repeat(40),
  },
}));

// Pass-through funding mutex (serialization is exercised by jitFunding's own logic).
jest.mock("../jitFunding", () => ({
  runOnFundingChain: jest.fn(<T>(fn: () => Promise<T>) => fn()),
}));

const sendMock = jest.fn(
  async (_p: unknown, _w: unknown, fn: (nonce: number) => Promise<unknown>) => fn(0),
);
jest.mock("../nonceManager", () => ({
  signingLayerNonceManager: { send: (...args: unknown[]) => sendMock(...(args as [unknown, unknown, (n: number) => Promise<unknown>])) },
}));

const wrapMock = jest.fn(async () => undefined);
jest.mock("../depositWalletExecutor", () => ({
  getDepositWalletExecutor: jest.fn(() => ({ kind: "mock" })),
  wrapUsdcToPusd: (...args: unknown[]) => wrapMock(...(args as [unknown, bigint])),
}));

const wallet = { address: "0x1234" } as unknown as ethers.Wallet;
const provider = {} as ethers.JsonRpcProvider;

// Build an ethers.Contract mock that serves BOTH the pUSD balanceOf read and the Vault
// fundPolymarketWallet call from one object. `balance` drives the top-up decision; `fundFn`
// lets a test make fundPolymarketWallet revert.
function mockContracts(balance: bigint, fundFn?: jest.Mock): jest.Mock {
  const fund =
    fundFn ??
    jest.fn(async () => ({ hash: "0xtx", wait: jest.fn().mockResolvedValue({}) }));
  jest.spyOn(ethers, "Contract").mockImplementation(
    () =>
      ({
        balanceOf: jest.fn().mockResolvedValue(balance),
        fundPolymarketWallet: fund,
      }) as unknown as ethers.Contract,
  );
  return fund;
}

// Let the immediate startup tick (and its mocked async funding chain) settle.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("bufferManager", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sendMock.mockClear();
    wrapMock.mockClear();
  });

  afterEach(async () => {
    const { stopBufferManager } = await import("../bufferManager");
    stopBufferManager();
  });

  it("below low-water: funds the deposit wallet up to target, then wraps", async () => {
    const fund = mockContracts(5_000_000n); // $5 < $10 low-water
    const { startBufferManager } = await import("../bufferManager");
    startBufferManager(provider, wallet);
    await flush();

    // top-up = target − balance = 30e6 − 5e6 = 25e6
    expect(fund).toHaveBeenCalledWith(25_000_000n, expect.objectContaining({ nonce: 0 }));
    expect(wrapMock).toHaveBeenCalledWith(expect.anything(), 25_000_000n);
  });

  it("healthy (>= low-water): does NOT fund or wrap", async () => {
    const fund = mockContracts(40_000_000n); // $40 >= $10 low-water
    const { startBufferManager } = await import("../bufferManager");
    startBufferManager(provider, wallet);
    await flush();

    expect(fund).not.toHaveBeenCalled();
    expect(wrapMock).not.toHaveBeenCalled();
  });

  it("fundPolymarketWallet revert (e.g. DeployCapExceeded) is caught — no crash, no wrap", async () => {
    const reverting = jest.fn(async () => {
      throw new Error("DeployCapExceeded()");
    });
    mockContracts(1_000_000n, reverting); // below low-water → attempts a top-up
    const { startBufferManager } = await import("../bufferManager");
    // Must not throw synchronously or leave an unhandled rejection.
    startBufferManager(provider, wallet);
    await flush();

    expect(reverting).toHaveBeenCalled();
    expect(wrapMock).not.toHaveBeenCalled(); // wrap is skipped because funding threw
  });

  it("disabled when low-water is 0 (no contract reads)", async () => {
    jest.resetModules();
    jest.doMock("../config", () => ({
      config: { bufferLowWaterUsdc: 0n, bufferTargetUsdc: 0n, bufferManagerPollMs: 10_000_000 },
    }));
    const ctor = jest.spyOn(ethers, "Contract");
    const { startBufferManager } = await import("../bufferManager");
    startBufferManager(provider, wallet);
    await flush();
    expect(ctor).not.toHaveBeenCalled();
    jest.dontMock("../config");
    jest.resetModules();
  });
});
