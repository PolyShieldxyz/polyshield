// Tests for critical signing-layer behaviors.
// The clob-client and ethers contract calls are mocked so no live network is needed.
// IMPORTANT: These tests must never use a real VAULT_EOA_PRIVATE_KEY or real USDC.

jest.mock("@polymarket/clob-client-v2", () => ({
  ClobClient: jest.fn().mockImplementation(() => ({
    createAndSendOrder: jest.fn(),
  })),
}));

import { ethers } from "ethers";

// Prevent real env var reads
jest.mock("../config.js", () => ({
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

jest.mock("../circuitBreaker.js", () => ({
  checkResponse: jest.fn(),
  isHalted: jest.fn().mockReturnValue(false),
}));

describe("orderBuilder", () => {
  let mockReportFilled: jest.Mock;
  let mockReportFOKFailure: jest.Mock;
  let mockCreateAndSendOrder: jest.Mock;
  let mockWait: jest.Mock;

  const event = {
    nullifier: "0x" + "1".repeat(64),
    market_id: "0x" + "2".repeat(64),
    position_id: "0x" + "3".repeat(64),
    expected_shares: 200_000_000n,
    bet_amount: 100_000_000n, // $100 USDC
    price: 50_000_000n, // 50 cents
    new_commitment: "0x" + "4".repeat(64),
  };

  beforeEach(() => {
    jest.clearAllMocks();

    mockWait = jest.fn().mockResolvedValue(undefined);
    mockReportFilled = jest.fn().mockResolvedValue({ wait: mockWait });
    mockReportFOKFailure = jest.fn().mockResolvedValue({ wait: mockWait });
    mockCreateAndSendOrder = jest.fn();

    // Mock ethers.Contract
    jest.spyOn(ethers, "Contract").mockImplementation(() => ({
      reportFilled: mockReportFilled,
      reportFOKFailure: mockReportFOKFailure,
    }) as unknown as ethers.Contract);

    // Wire clob client mock
    const { ClobClient } = require("@polymarket/clob-client-v2");
    ClobClient.mockImplementation(() => ({
      createAndSendOrder: mockCreateAndSendOrder,
    }));
  });

  it("calls reportFilled when order status is matched", async () => {
    mockCreateAndSendOrder.mockResolvedValue({ status: "matched" });
    const { submitFOKOrder } = await import("../orderBuilder.js");
    const wallet = { address: "0x1234" } as unknown as ethers.Wallet;
    const provider = {} as ethers.JsonRpcProvider;
    await submitFOKOrder(event, wallet, provider);
    expect(mockReportFilled).toHaveBeenCalledWith(event.nullifier);
    expect(mockReportFOKFailure).not.toHaveBeenCalled();
  });

  it("calls reportFOKFailure when order is not filled", async () => {
    mockCreateAndSendOrder.mockResolvedValue({ status: "unmatched" });
    const { submitFOKOrder } = await import("../orderBuilder.js");
    const wallet = { address: "0x1234" } as unknown as ethers.Wallet;
    const provider = {} as ethers.JsonRpcProvider;
    await submitFOKOrder(event, wallet, provider);
    expect(mockReportFOKFailure).toHaveBeenCalledWith(event.nullifier);
    expect(mockReportFilled).not.toHaveBeenCalled();
  });

  it("order type is always FOK", async () => {
    mockCreateAndSendOrder.mockResolvedValue({ status: "matched" });
    const { submitFOKOrder } = await import("../orderBuilder.js");
    const wallet = { address: "0x1234" } as unknown as ethers.Wallet;
    const provider = {} as ethers.JsonRpcProvider;
    await submitFOKOrder(event, wallet, provider);
    const [orderArgs] = mockCreateAndSendOrder.mock.calls[0];
    expect(orderArgs.orderType).toBe("FOK");
  });

  it("does not submit order when circuit breaker is halted", async () => {
    const { isHalted } = require("../circuitBreaker.js");
    isHalted.mockReturnValue(true);
    const { submitFOKOrder } = await import("../orderBuilder.js");
    const wallet = { address: "0x1234" } as unknown as ethers.Wallet;
    const provider = {} as ethers.JsonRpcProvider;
    await submitFOKOrder(event, wallet, provider);
    expect(mockCreateAndSendOrder).not.toHaveBeenCalled();
  });
});
