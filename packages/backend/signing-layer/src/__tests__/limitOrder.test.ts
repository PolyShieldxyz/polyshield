// FC-4 + FC-9: tests for submitLimitOrder's submit-and-register behavior. After the
// websocket-tracking rewrite, submitLimitOrder no longer blocks on a REST poll or attest
// synchronously — on a "live" ack it records a non-binding RESTING UI signal and hands the
// order to the websocket fill tracker (mocked here), which drives the terminal attestation
// asynchronously (see wsFillTracker.test.ts / terminalAttestation.test.ts for that path).
// No live network; fetch, contract, the tracker, and the attestation store are mocked.

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

// The websocket fill tracker is mocked: submitLimitOrder's job is to submit + register.
jest.mock("../wsFillTracker", () => ({ trackOrder: jest.fn() }));

jest.mock("../attestationStore", () => ({
  ReportType: { FILLED: 1, FAILED: 2, PARTIAL: 3, SOLD: 4 },
  getAttestationDomainParams: jest.fn(() => ({ chainId: 31337, verifyingContract: "0x" + "b".repeat(40) })),
  markResting: jest.fn(),
  signAndStoreAttestation: jest.fn(),
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

describe("submitLimitOrder submit-and-register (FC-4 websocket handoff)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let store: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let trackerMod: any;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.POLY_API_URL = "http://localhost:3001";
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    store = require("../attestationStore");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    trackerMod = require("../wsFillTracker");

    jest.spyOn(ethers, "Contract").mockImplementation(() => ({
      balanceOf: jest.fn().mockResolvedValue(10_000_000_000n),
    }) as unknown as ethers.Contract);

    // POST /order → live + orderID.
    global.fetch = jest.fn(async () => ({
      ok: true, status: 200, json: async () => ({ success: true, status: "live", orderID: "0xorder1" }),
    } as unknown as Response)) as unknown as typeof fetch;
  });

  const run = async (orderType: "GTC" | "GTD" = "GTC", expiration = 0) => {
    const { submitLimitOrder } = await import("../orderBuilder");
    await submitLimitOrder(event, { orderType, expiration }, { address: "0x1234" } as unknown as ethers.Wallet, {} as ethers.JsonRpcProvider);
  };

  it("on 'live' ack: records RESTING and registers the order with the tracker (no sync attestation)", async () => {
    await run("GTC");
    expect(store.markResting).toHaveBeenCalledWith(event.nullifier);
    expect(trackerMod.trackOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        nullifier: event.nullifier,
        orderID: "0xorder1",
        conditionId: event.market_id,
        tokenId: event.position_id,
        expected_shares: event.expected_shares,
        bet_amount: event.bet_amount,
        price: event.price,
        orderType: "GTC",
      }),
    );
    expect(store.signAndStoreAttestation).not.toHaveBeenCalled();
  });

  it("does not register when no orderID is returned", async () => {
    global.fetch = jest.fn(async () => ({
      ok: true, status: 200, json: async () => ({ success: true, status: "live" }),
    } as unknown as Response)) as unknown as typeof fetch;
    await run("GTC");
    expect(trackerMod.trackOrder).not.toHaveBeenCalled();
  });

  it("does not submit when circuit breaker is halted", async () => {
    const { isHalted } = require("../circuitBreaker");
    isHalted.mockReturnValue(true);
    await run("GTC");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(trackerMod.trackOrder).not.toHaveBeenCalled();
  });
});
