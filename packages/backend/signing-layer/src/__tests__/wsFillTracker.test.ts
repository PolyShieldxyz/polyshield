// FC-4: tests for the user-channel websocket fill tracker. The `ws` module is mocked
// with an EventEmitter fake so we can drive open/message events; the attestation store is
// mocked (idempotent, single-write) and tracked-order persistence uses an in-memory
// sqlite DB. Asserts terminal mapping, websocket→attest, REST reconcile, and idempotency.

import { ethers } from "ethers";

process.env.SETTLEMENT_DB_PATH = ":memory:";

jest.mock("../config", () => ({
  config: {
    polyWsUrl: "ws://localhost:3001/ws/user",
    polyApiKey: "k",
    polySecret: "s",
    polyPassphrase: "p",
  },
}));

jest.mock("ws", () => {
  const { EventEmitter } = require("events");
  class MockWS extends EventEmitter {
    static OPEN = 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static instances: any[] = [];
    readyState = 1;
    url: string;
    send = jest.fn();
    close = jest.fn();
    constructor(url: string) {
      super();
      this.url = url;
      MockWS.instances.push(this);
    }
  }
  return { __esModule: true, default: MockWS, WebSocket: MockWS };
});

const ReportType = { FILLED: 1, FAILED: 2, PARTIAL: 3, SOLD: 4 };
jest.mock("../attestationStore", () => {
  const rows = new Map<string, { reportType: number; amountA: bigint; amountB: bigint }>();
  const signCount = { n: 0 };
  return {
    ReportType: { FILLED: 1, FAILED: 2, PARTIAL: 3, SOLD: 4 },
    getAttestationDomainParams: jest.fn(() => ({ chainId: 31337, verifyingContract: "0x" + "b".repeat(40) })),
    getAttestation: jest.fn(() => null),
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

const flush = () => new Promise((r) => setImmediate(r));
const wallet = { address: "0x1234" } as unknown as ethers.Wallet;

const order = {
  nullifier: "0x" + "1".repeat(64),
  orderID: "0xorder1",
  conditionId: "0x" + "2".repeat(64),
  tokenId: "0x" + "3".repeat(64),
  expected_shares: 200_000_000n,
  bet_amount: 100_000_000n,
  price: 50_000_000n,
  orderType: "GTC" as const,
  expiration: 0,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function load(): Promise<{ tracker: any; store: any; ws: any }> {
  jest.resetModules();
  process.env.POLY_API_URL = "http://localhost:3001";
  process.env.SETTLEMENT_DB_PATH = ":memory:";
  // fetch defaults to a non-terminal/not-ok response so reconcile is a no-op unless a
  // test overrides it.
  global.fetch = jest.fn(async () => ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response)) as unknown as typeof fetch;
  const tracker = await import("../wsFillTracker");
  const store = await import("../attestationStore");
  const ws = (await import("ws")).default as unknown as { instances: { emit: (e: string, d?: unknown) => void }[] };
  return { tracker, store, ws };
}

describe("wsFillTracker", () => {
  it("websocket terminal 'matched' order message → attest FILLED", async () => {
    const { tracker, store, ws } = await load();
    tracker.startFillTracker(wallet);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inst: any = ws.instances[ws.instances.length - 1];
    inst.emit("open");
    tracker.trackOrder(order);
    inst.emit("message", JSON.stringify({ event_type: "order", orderID: order.orderID, status: "matched", filledShares: 200_000_000, spentAmount: 100_000_000 }));
    await flush();
    expect((store as { signAndStoreAttestation: jest.Mock }).signAndStoreAttestation).toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      { nullifierOfBet: order.nullifier, reportType: ReportType.FILLED, amountA: 0n, amountB: 0n },
    );
    tracker.stopFillTracker();
  });

  it("websocket terminal 'partial' order message → attest PARTIAL", async () => {
    const { tracker, store, ws } = await load();
    tracker.startFillTracker(wallet);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inst: any = ws.instances[ws.instances.length - 1];
    inst.emit("open");
    tracker.trackOrder(order);
    inst.emit("message", JSON.stringify({ event_type: "order", orderID: order.orderID, status: "partial", filledShares: 120_000_000, spentAmount: 60_000_000 }));
    await flush();
    expect((store as { signAndStoreAttestation: jest.Mock }).signAndStoreAttestation).toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      { nullifierOfBet: order.nullifier, reportType: ReportType.PARTIAL, amountA: 120_000_000n, amountB: 60_000_000n },
    );
    tracker.stopFillTracker();
  });

  it("websocket terminal 'cancelled' with zero fill → attest FAILED", async () => {
    const { tracker, store, ws } = await load();
    tracker.startFillTracker(wallet);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inst: any = ws.instances[ws.instances.length - 1];
    inst.emit("open");
    tracker.trackOrder(order);
    inst.emit("message", JSON.stringify({ event_type: "order", orderID: order.orderID, status: "cancelled", filledShares: 0, spentAmount: 0 }));
    await flush();
    expect((store as { signAndStoreAttestation: jest.Mock }).signAndStoreAttestation).toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      { nullifierOfBet: order.nullifier, reportType: ReportType.FAILED, amountA: 0n, amountB: 0n },
    );
    tracker.stopFillTracker();
  });

  it("idempotent: duplicate terminal messages attest exactly once", async () => {
    const { tracker, store, ws } = await load();
    tracker.startFillTracker(wallet);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inst: any = ws.instances[ws.instances.length - 1];
    inst.emit("open");
    tracker.trackOrder(order);
    const msg = JSON.stringify({ event_type: "order", orderID: order.orderID, status: "matched", filledShares: 200_000_000, spentAmount: 100_000_000 });
    inst.emit("message", msg);
    inst.emit("message", msg);
    await flush();
    expect((store as { __signCount: { n: number } }).__signCount.n).toBe(1);
    tracker.stopFillTracker();
  });

  it("REST reconcile attests when an order filled while disconnected", async () => {
    const { tracker, store } = await load();
    // Override fetch to report a terminal matched state for GET /order/:id.
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ status: "matched", filledShares: 200_000_000, spentAmount: 100_000_000 }) } as unknown as Response)) as unknown as typeof fetch;
    tracker.startFillTracker(wallet);
    tracker.trackOrder(order); // trackOrder runs reconcileOne → fetch terminal → finalize
    await flush();
    expect((store as { signAndStoreAttestation: jest.Mock }).signAndStoreAttestation).toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      { nullifierOfBet: order.nullifier, reportType: ReportType.FILLED, amountA: 0n, amountB: 0n },
    );
    tracker.stopFillTracker();
  });
});
