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
  side: "BUY" as const,
  sellLimitPrice: 0n,
  takerFeeUsd: 0n,
};

// FC-1: a resting SELL close (side: SELL) of the same position at a 0.60 limit.
const sellOrder = {
  nullifier: "0x" + "1".repeat(64),
  orderID: "0xsell1",
  conditionId: "0x" + "2".repeat(64),
  tokenId: "0x" + "3".repeat(64),
  expected_shares: 200_000_000n, // target sell size
  bet_amount: 0n,
  price: 0n,
  orderType: "GTC" as const,
  expiration: 0,
  side: "SELL" as const,
  sellLimitPrice: 600_000n, // 0.60 (1e6-scaled)
  takerFeeUsd: 0n,
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

  // ── FC-1: resting SELL (position close) ──────────────────────────────────────
  it("resting SELL partial fill → SOLD (filled, proceeds at the sell limit)", async () => {
    const { tracker, store, ws } = await load();
    tracker.startFillTracker(wallet);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inst: any = ws.instances[ws.instances.length - 1];
    inst.emit("open");
    tracker.trackOrder(sellOrder);
    // 120 of 200 shares matched; proceeds = 120 × 0.60 = 72 USDC (derived from sellLimitPrice).
    inst.emit("message", JSON.stringify({ event_type: "order", orderID: sellOrder.orderID, status: "partial", size_matched: 120 }));
    await flush();
    expect((store as { signAndStoreAttestation: jest.Mock }).signAndStoreAttestation).toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      { nullifierOfBet: sellOrder.nullifier, reportType: ReportType.SOLD, amountA: 120_000_000n, amountB: 72_000_000n },
    );
    tracker.stopFillTracker();
  });

  it("resting SELL full fill → SOLD with amountA snapped to expected (within DUST)", async () => {
    const { tracker, store, ws } = await load();
    tracker.startFillTracker(wallet);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inst: any = ws.instances[ws.instances.length - 1];
    inst.emit("open");
    tracker.trackOrder(sellOrder);
    inst.emit("message", JSON.stringify({ event_type: "order", orderID: sellOrder.orderID, status: "matched", size_matched: 200 }));
    await flush();
    expect((store as { signAndStoreAttestation: jest.Mock }).signAndStoreAttestation).toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      { nullifierOfBet: sellOrder.nullifier, reportType: ReportType.SOLD, amountA: 200_000_000n, amountB: 120_000_000n },
    );
    tracker.stopFillTracker();
  });

  it("resting SELL zero fill → NO attestation (position unchanged, not FAILED)", async () => {
    const { tracker, store, ws } = await load();
    tracker.startFillTracker(wallet);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inst: any = ws.instances[ws.instances.length - 1];
    inst.emit("open");
    tracker.trackOrder(sellOrder);
    inst.emit("message", JSON.stringify({ event_type: "order", orderID: sellOrder.orderID, status: "cancelled", filledShares: 0, spentAmount: 0 }));
    await flush();
    expect((store as { signAndStoreAttestation: jest.Mock }).signAndStoreAttestation).not.toHaveBeenCalled();
    expect((store as { __signCount: { n: number } }).__signCount.n).toBe(0);
    tracker.stopFillTracker();
  });

  // BUG-6: a SELL close rests on an already-FILLED bet. trackOrder/resume must anti-join against the
  // SOLD slot, NOT the bet's FILLED outcome — else the resting close is dropped. (trackOrder and the
  // restart resume share the same `alreadyAttested` helper.)
  it("trackOrder keeps a SELL close even when the bet already has a FILLED outcome", async () => {
    const { tracker, store } = await load();
    (store as { getAttestation: jest.Mock }).getAttestation.mockImplementation(
      (_n: string, rt?: number) => (rt === undefined ? { reportType: ReportType.FILLED } : null),
    );
    tracker.startFillTracker(wallet);
    tracker.trackOrder(sellOrder);
    expect(tracker.isOrderTracked(sellOrder.nullifier)).toBe(true); // not skipped despite the FILLED outcome
    tracker.stopFillTracker();
  });

  // FC fee hole (a): a crossing limit BUY took liquidity (taker) → its crossed-portion fee is carried
  // on the tracked order and ADDED to spent at terminal, so it is NOT refunded.
  it("BUY takerFeeUsd is added to spent (crossing-limit fee not refunded)", async () => {
    const { tracker, store, ws } = await load();
    tracker.startFillTracker(wallet);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inst: any = ws.instances[ws.instances.length - 1];
    inst.emit("open");
    tracker.trackOrder({ ...order, takerFeeUsd: 5_000_000n }); // $5 crossed-portion fee
    // Partial fill: 120 of 200 shares, $60 on shares; spent must include the $5 fee → $65.
    inst.emit("message", JSON.stringify({ event_type: "order", orderID: order.orderID, status: "partial", filledShares: 120_000_000, spentAmount: 60_000_000 }));
    await flush();
    expect((store as { signAndStoreAttestation: jest.Mock }).signAndStoreAttestation).toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      { nullifierOfBet: order.nullifier, reportType: ReportType.PARTIAL, amountA: 120_000_000n, amountB: 65_000_000n },
    );
    tracker.stopFillTracker();
  });

  // FC fee hole (b): a crossing limit SELL → its crossed-portion fee is SUBTRACTED from proceeds.
  it("SELL takerFeeUsd is subtracted from proceeds", async () => {
    const { tracker, store, ws } = await load();
    tracker.startFillTracker(wallet);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inst: any = ws.instances[ws.instances.length - 1];
    inst.emit("open");
    tracker.trackOrder({ ...sellOrder, takerFeeUsd: 2_000_000n }); // $2 crossed-portion fee
    // 120 of 200 shares sold at 0.60 → $72 gross proceeds; net of the $2 fee → $70.
    inst.emit("message", JSON.stringify({ event_type: "order", orderID: sellOrder.orderID, status: "partial", size_matched: 120 }));
    await flush();
    expect((store as { signAndStoreAttestation: jest.Mock }).signAndStoreAttestation).toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      { nullifierOfBet: sellOrder.nullifier, reportType: ReportType.SOLD, amountA: 120_000_000n, amountB: 70_000_000n },
    );
    tracker.stopFillTracker();
  });
});
