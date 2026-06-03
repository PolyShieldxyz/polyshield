/**
 * FC-4: production GTC/GTD limit-order fill tracking over the Polymarket user-channel
 * websocket (`wss://ws-subscriptions-clob.polymarket.com/ws/user`), with a REST
 * reconcile backstop. Replaces the old in-line REST poll in submitLimitOrder.
 *
 * Lifecycle:
 *   submitLimitOrder() submits a resting order, then calls trackOrder() to register it
 *   here. This module keeps ONE authenticated websocket open, subscribed to the
 *   condition ids of the orders it is tracking, and maps each order's TERMINAL state
 *   onto exactly one operator attestation via the shared attestTerminal() helper:
 *       fully filled            → FILLED
 *       partial then ended      → PARTIAL  (user reclaims the remainder)
 *       cancelled / expired-0   → FAILED   (user reclaims all)
 *
 * Correctness:
 *   - We attest only when an order LEAVES THE BOOK (an order-status message), never on
 *     an intermediate trade — a partial-then-more-fills must not lock a premature
 *     PARTIAL.
 *   - The attestation store is single-write/idempotent, so a websocket event racing the
 *     REST reconcile (or a duplicate delivery) cannot double-attest: the first terminal
 *     write wins.
 *
 * Resilience:
 *   - Reconnect with backoff; on (re)connect we re-subscribe and run a REST reconcile
 *     for every tracked order to catch fills missed while disconnected.
 *   - A slow periodic reconcile timer is the steady-state backstop for both transports.
 *   - Tracked orders are persisted (tracked_orders table); on boot we reload every
 *     tracked order that has no terminal attestation yet and resume tracking it. This
 *     survives a signing-layer restart while an order is still resting.
 *
 * The same code runs in dev: the mock CLOB exposes a Polymarket-shaped `/ws/user`
 * endpoint (see mock-clob-server) so this client is exercised by `pnpm dev:mock`.
 */

import WebSocket from "ws";
import { ethers } from "ethers";
import pino from "pino";
import Database from "better-sqlite3";
import path from "path";
import { config } from "./config";
import { getAttestation } from "./attestationStore";
import { attestTerminal } from "./terminalAttestation";

const logger = pino({ name: "ws-fill-tracker" });

export interface TrackedOrder {
  nullifier: string;
  orderID: string;
  /** CTF conditionId / CLOB market id — used as the websocket subscribe `markets` key. */
  conditionId: string;
  /** position id / token id (asset_id in user-channel messages). */
  tokenId: string;
  expected_shares: bigint;
  bet_amount: bigint;
  /** 1e6-scaled limit price, used to derive spent_amount from a shares-only fill. */
  price: bigint;
  orderType: "GTC" | "GTD";
  /** GTD unix-seconds expiry (0 for GTC). */
  expiration: number;
}

// ── Persistence (tracked_orders) ────────────────────────────────────────────
const DB_PATH = process.env.SETTLEMENT_DB_PATH ?? path.join(process.cwd(), "settlement.db");
let _db: Database.Database | null = null;
function db(): Database.Database {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS tracked_orders (
      nullifier_of_bet TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      condition_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      expected_shares TEXT NOT NULL,
      bet_amount TEXT NOT NULL,
      price TEXT NOT NULL,
      order_type TEXT NOT NULL,
      expiration INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `);
  return _db;
}

function persist(o: TrackedOrder): void {
  db()
    .prepare(
      `INSERT INTO tracked_orders
         (nullifier_of_bet, order_id, condition_id, token_id, expected_shares, bet_amount, price, order_type, expiration, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(nullifier_of_bet) DO UPDATE SET
         order_id = excluded.order_id, condition_id = excluded.condition_id,
         token_id = excluded.token_id, expected_shares = excluded.expected_shares,
         bet_amount = excluded.bet_amount, price = excluded.price,
         order_type = excluded.order_type, expiration = excluded.expiration`,
    )
    .run(
      o.nullifier, o.orderID, o.conditionId, o.tokenId,
      o.expected_shares.toString(), o.bet_amount.toString(), o.price.toString(),
      o.orderType, o.expiration, Math.floor(Date.now() / 1000),
    );
}

function unpersist(nullifier: string): void {
  db().prepare(`DELETE FROM tracked_orders WHERE nullifier_of_bet = ?`).run(nullifier);
}

interface TrackedRow {
  nullifier_of_bet: string; order_id: string; condition_id: string; token_id: string;
  expected_shares: string; bet_amount: string; price: string; order_type: string; expiration: number;
}

function loadPersisted(): TrackedOrder[] {
  const rows = db()
    .prepare(`SELECT nullifier_of_bet, order_id, condition_id, token_id, expected_shares, bet_amount, price, order_type, expiration FROM tracked_orders`)
    .all() as TrackedRow[];
  return rows.map((r) => ({
    nullifier: r.nullifier_of_bet,
    orderID: r.order_id,
    conditionId: r.condition_id,
    tokenId: r.token_id,
    expected_shares: BigInt(r.expected_shares),
    bet_amount: BigInt(r.bet_amount),
    price: BigInt(r.price),
    orderType: r.order_type === "GTD" ? "GTD" : "GTC",
    expiration: r.expiration,
  }));
}

// ── Tracker state ────────────────────────────────────────────────────────────
const byOrderId = new Map<string, TrackedOrder>();
const finalized = new Set<string>(); // nullifiers we've already attested for this process
let _wallet: ethers.Wallet | null = null;
let _ws: WebSocket | null = null;
let _connecting = false;
let _stopped = false;
let _reconnectAttempts = 0;
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _reconcileTimer: ReturnType<typeof setInterval> | null = null;

const RECONCILE_INTERVAL_MS = 30_000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

function httpHost(): string {
  return process.env.POLY_API_URL ?? "https://clob.polymarket.com";
}

// ── Public API ─────────────────────────────────────────────────────────────
/**
 * Start the fill tracker: reload any persisted (un-attested) tracked orders, then
 * connect the websocket and start the periodic reconcile. Idempotent.
 */
export function startFillTracker(wallet: ethers.Wallet): void {
  _wallet = wallet;
  _stopped = false;

  // Boot reconcile: resume tracking orders that were resting when we last stopped and
  // have not reached a terminal attestation yet (anti-join against the attestations
  // store). Drop ones already attested.
  for (const o of loadPersisted()) {
    if (getAttestation(o.nullifier)) {
      unpersist(o.nullifier);
      finalized.add(o.nullifier);
      continue;
    }
    byOrderId.set(o.orderID, o);
  }
  logger.info({ tracking: byOrderId.size }, "fill tracker started — resumed persisted orders");

  connect();
  if (!_reconcileTimer) {
    _reconcileTimer = setInterval(() => void reconcileAll(), RECONCILE_INTERVAL_MS);
  }
  // Reconcile once now to catch fills that happened while we were down.
  void reconcileAll();
}

export function stopFillTracker(): void {
  _stopped = true;
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  if (_reconcileTimer) { clearInterval(_reconcileTimer); _reconcileTimer = null; }
  try { _ws?.close(); } catch { /* ignore */ }
  _ws = null;
}

/**
 * Register a freshly-submitted resting order for fill tracking. Persists it (crash
 * recovery), adds it to the in-memory registry, and (re)subscribes so the websocket
 * receives its fills.
 */
export function trackOrder(o: TrackedOrder): void {
  if (finalized.has(o.nullifier) || getAttestation(o.nullifier)) return;
  persist(o);
  byOrderId.set(o.orderID, o);
  logger.info({ nullifier: o.nullifier, orderID: o.orderID, conditionId: o.conditionId }, "tracking resting order");
  subscribe();
  // In case the order already filled between submit and subscribe.
  void reconcileOne(o);
}

// ── Websocket ────────────────────────────────────────────────────────────────
function connect(): void {
  if (_stopped || _connecting || (_ws && _ws.readyState === WebSocket.OPEN)) return;
  _connecting = true;
  const url = config.polyWsUrl;
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    _connecting = false;
    logger.warn({ err, url }, "ws construction failed — scheduling reconnect");
    scheduleReconnect();
    return;
  }
  _ws = ws;

  ws.on("open", () => {
    _connecting = false;
    _reconnectAttempts = 0;
    logger.info({ url }, "user-channel websocket connected");
    subscribe();
    void reconcileAll();
  });

  ws.on("message", (data: WebSocket.RawData) => {
    try {
      handleMessage(data.toString());
    } catch (err) {
      logger.warn({ err }, "ws message handling failed");
    }
  });

  ws.on("close", () => {
    _connecting = false;
    if (_ws === ws) _ws = null;
    if (!_stopped) { logger.warn("user-channel websocket closed — reconnecting"); scheduleReconnect(); }
  });

  ws.on("error", (err: Error) => {
    _connecting = false;
    logger.warn({ err: err?.message }, "user-channel websocket error");
    try { ws.close(); } catch { /* ignore */ }
  });
}

function scheduleReconnect(): void {
  if (_stopped || _reconnectTimer) return;
  const delay = RECONNECT_DELAYS_MS[Math.min(_reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)];
  _reconnectAttempts += 1;
  _reconnectTimer = setTimeout(() => { _reconnectTimer = null; connect(); }, delay);
}

/**
 * (Re)send the user-channel subscribe with the auth object and the set of condition
 * ids we're currently tracking. Polymarket filters the user channel by api key; the
 * markets array narrows it to our conditions.
 */
function subscribe(): void {
  if (!_ws || _ws.readyState !== WebSocket.OPEN) return;
  const markets = Array.from(new Set(Array.from(byOrderId.values()).map((o) => o.conditionId)));
  const msg = {
    type: "user",
    auth: { apiKey: config.polyApiKey, secret: config.polySecret, passphrase: config.polyPassphrase },
    markets,
  };
  try { _ws.send(JSON.stringify(msg)); } catch (err) { logger.warn({ err }, "ws subscribe send failed"); }
}

// ── Message handling ──────────────────────────────────────────────────────────
interface UserChannelMsg {
  event_type?: string;       // "trade" | "order"
  type?: string;             // "TRADE" | "PLACEMENT" | "UPDATE" | "CANCELLATION" | "order"
  status?: string;           // order/trade status
  market?: string;           // condition id
  asset_id?: string;         // token id
  id?: string;
  order_id?: string;
  orderID?: string;          // mock convenience
  size_matched?: string | number;
  filledShares?: number;     // mock convenience, 1e6-scaled
  spentAmount?: number;      // mock convenience, 1e6-scaled
}

function handleMessage(raw: string): void {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return; }
  const msgs: UserChannelMsg[] = Array.isArray(parsed) ? (parsed as UserChannelMsg[]) : [parsed as UserChannelMsg];
  for (const m of msgs) handleOne(m);
}

/** Treat a message as an order-lifecycle update (vs an informational trade). */
function isOrderMessage(m: UserChannelMsg): boolean {
  const et = (m.event_type ?? "").toLowerCase();
  const t = (m.type ?? "").toLowerCase();
  if (et === "order") return true;
  if (t === "order" || t === "placement" || t === "update" || t === "cancellation") return true;
  // Mock convenience: an explicit fill snapshot is an order-state message.
  return m.filledShares !== undefined || m.spentAmount !== undefined;
}

/** Is this order status terminal (the order has left the book)? */
function classifyTerminal(status: string, filled: bigint): "matched" | "partial" | "cancelled" | null {
  const s = status.toLowerCase();
  if (s === "matched" || s === "filled") return "matched";
  if (s === "partial") return "partial";
  if (s === "cancelled" || s === "canceled" || s === "expired") {
    return filled > 0n ? "partial" : "cancelled";
  }
  return null; // live / placement / trade-while-live → not terminal
}

function findTracked(m: UserChannelMsg): TrackedOrder | undefined {
  const oid = m.orderID ?? m.order_id ?? m.id;
  if (oid && byOrderId.has(oid)) return byOrderId.get(oid);
  // Fallback: match by token id (asset_id) when no order id is carried.
  if (m.asset_id) {
    for (const o of byOrderId.values()) if (o.tokenId === m.asset_id) return o;
  }
  return undefined;
}

/** Extract (filled_shares, spent_amount) in 1e6 units from a message + tracked order. */
function extractFill(m: UserChannelMsg, o: TrackedOrder): { filled: bigint; spent: bigint } {
  if (typeof m.filledShares === "number" && typeof m.spentAmount === "number") {
    return { filled: BigInt(Math.floor(m.filledShares)), spent: BigInt(Math.floor(m.spentAmount)) };
  }
  // Production best-effort: size_matched is matched shares (decimal). Derive spent from
  // the limit price. TODO(FC-4): validate against the real user-channel field names.
  if (m.size_matched !== undefined) {
    const shares = typeof m.size_matched === "number" ? m.size_matched : parseFloat(String(m.size_matched));
    const filled = BigInt(Math.floor(shares * 1e6));
    const spent = (filled * o.price) / 1_000_000n;
    return { filled, spent };
  }
  return { filled: 0n, spent: 0n };
}

function handleOne(m: UserChannelMsg): void {
  if (!isOrderMessage(m)) return;
  const tracked = findTracked(m);
  if (!tracked || finalized.has(tracked.nullifier)) return;
  const { filled, spent } = extractFill(m, tracked);
  const terminal = classifyTerminal(m.status ?? "", filled);
  if (!terminal) return;
  void finalize(tracked, terminal, filled, spent);
}

// ── Finalization + reconcile ────────────────────────────────────────────────
async function finalize(o: TrackedOrder, status: string, filled: bigint, spent: bigint): Promise<void> {
  if (finalized.has(o.nullifier)) return;
  finalized.add(o.nullifier); // best-effort local dedupe; store enforces the hard invariant
  if (!_wallet) {
    logger.warn({ nullifier: o.nullifier }, "fill tracker has no wallet yet — deferring to reconcile");
    finalized.delete(o.nullifier);
    return;
  }
  logger.info(
    { nullifier: o.nullifier, orderID: o.orderID, status, filled: filled.toString(), spent: spent.toString() },
    "limit order reached terminal state — attesting",
  );
  await attestTerminal(_wallet, o, status, filled, spent);
  byOrderId.delete(o.orderID);
  unpersist(o.nullifier);
}

/** One-shot REST reconcile for a single tracked order (mock: GET /order/:id). */
async function reconcileOne(o: TrackedOrder): Promise<void> {
  if (finalized.has(o.nullifier)) return;
  try {
    const res = await fetch(`${httpHost()}/order/${o.orderID}`);
    if (!res.ok) return;
    const state = (await res.json()) as { status?: string; filledShares?: number; spentAmount?: number };
    if (!state.status || state.status === "live") return;
    const filled = BigInt(Math.floor(state.filledShares ?? 0));
    const spent = BigInt(Math.floor(state.spentAmount ?? 0));
    const terminal = classifyTerminal(state.status, filled);
    if (terminal) await finalize(o, terminal, filled, spent);
  } catch (err) {
    logger.debug({ err, orderID: o.orderID }, "reconcileOne failed (best-effort)");
  }
}

async function reconcileAll(): Promise<void> {
  const orders = Array.from(byOrderId.values());
  for (const o of orders) await reconcileOne(o);
}
