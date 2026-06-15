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
import { getAttestation, ReportType } from "./attestationStore";
import { attestTerminal } from "./terminalAttestation";
import { getClobCreds, type ClobCreds } from "./clobAuth";

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
  /** 1e8-scaled committed price (== event.price), used to derive spent_amount from a shares-only fill. */
  price: bigint;
  orderType: "GTC" | "GTD";
  /** GTD unix-seconds expiry (0 for GTC). */
  expiration: number;
  /**
   * Order side. BUY = a bet entry (terminal attestation = FILLED/FAILED/PARTIAL). SELL = a
   * position close (FC-1; terminal attestation = SOLD). Defaults to BUY for legacy rows.
   */
  side: "BUY" | "SELL";
  /** SELL close only: the user's 1e6-scaled sell limit price, used to derive proceeds. 0 for BUY. */
  sellLimitPrice: bigint;
  /**
   * CLOB taker fee (1e6-scaled USDC) on the portion this order CROSSED on submission (took
   * liquidity). BUY → added to `spent` (the fee is the user's cost, not refunded); SELL → subtracted
   * from proceeds. 0 for a pure resting (maker) fill — makers pay no fee.
   */
  takerFeeUsd: bigint;
}

/**
 * Has this order already reached its terminal attestation? A SELL close attests SOLD (reportType 4),
 * which COEXISTS with the bet's FILLED outcome — so a SELL must anti-join against SOLD, not the
 * bet-outcome row, or a resting close on a FILLED bet is wrongly treated as already-finalized and
 * dropped (BUG-6). A BUY anti-joins against the bet outcome (FILLED/FAILED/PARTIAL).
 */
function alreadyAttested(side: "BUY" | "SELL", nullifier: string): boolean {
  return side === "SELL"
    ? getAttestation(nullifier, ReportType.SOLD) != null
    : getAttestation(nullifier) != null;
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
      created_at INTEGER NOT NULL,
      side TEXT NOT NULL DEFAULT 'BUY',
      sell_limit_price TEXT NOT NULL DEFAULT '0',
      taker_fee_usd TEXT NOT NULL DEFAULT '0'
    )
  `);
  // FC-1 migration: add the SELL-close / fee columns to a pre-existing tracked_orders table
  // (CREATE TABLE IF NOT EXISTS won't alter it). Idempotent — a duplicate-column error means
  // the column already exists.
  try { _db.exec(`ALTER TABLE tracked_orders ADD COLUMN side TEXT NOT NULL DEFAULT 'BUY'`); } catch { /* column exists */ }
  try { _db.exec(`ALTER TABLE tracked_orders ADD COLUMN sell_limit_price TEXT NOT NULL DEFAULT '0'`); } catch { /* column exists */ }
  try { _db.exec(`ALTER TABLE tracked_orders ADD COLUMN taker_fee_usd TEXT NOT NULL DEFAULT '0'`); } catch { /* column exists */ }
  return _db;
}

function persist(o: TrackedOrder): void {
  db()
    .prepare(
      `INSERT INTO tracked_orders
         (nullifier_of_bet, order_id, condition_id, token_id, expected_shares, bet_amount, price, order_type, expiration, created_at, side, sell_limit_price, taker_fee_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(nullifier_of_bet) DO UPDATE SET
         order_id = excluded.order_id, condition_id = excluded.condition_id,
         token_id = excluded.token_id, expected_shares = excluded.expected_shares,
         bet_amount = excluded.bet_amount, price = excluded.price,
         order_type = excluded.order_type, expiration = excluded.expiration,
         side = excluded.side, sell_limit_price = excluded.sell_limit_price,
         taker_fee_usd = excluded.taker_fee_usd`,
    )
    .run(
      o.nullifier, o.orderID, o.conditionId, o.tokenId,
      o.expected_shares.toString(), o.bet_amount.toString(), o.price.toString(),
      o.orderType, o.expiration, Math.floor(Date.now() / 1000),
      o.side, o.sellLimitPrice.toString(), o.takerFeeUsd.toString(),
    );
}

function unpersist(nullifier: string): void {
  db().prepare(`DELETE FROM tracked_orders WHERE nullifier_of_bet = ?`).run(nullifier);
}

interface TrackedRow {
  nullifier_of_bet: string; order_id: string; condition_id: string; token_id: string;
  expected_shares: string; bet_amount: string; price: string; order_type: string; expiration: number;
  side: string | null; sell_limit_price: string | null; taker_fee_usd: string | null;
}

function loadPersisted(): TrackedOrder[] {
  const rows = db()
    .prepare(`SELECT nullifier_of_bet, order_id, condition_id, token_id, expected_shares, bet_amount, price, order_type, expiration, side, sell_limit_price, taker_fee_usd FROM tracked_orders`)
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
    side: r.side === "SELL" ? "SELL" : "BUY",
    sellLimitPrice: BigInt(r.sell_limit_price ?? "0"),
    takerFeeUsd: BigInt(r.taker_fee_usd ?? "0"),
  }));
}

// BN254 field modulus — a tracked order's conditionId is the BetAuthorized market_id
// (already reduced), so a resolution's raw conditionId must be compared mod this.
const BN254_P = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;
function sameMarket(a: string, b: string): boolean {
  try {
    return BigInt(a) % BN254_P === BigInt(b) % BN254_P;
  } catch {
    return false;
  }
}

// ── Tracker state ────────────────────────────────────────────────────────────
const byOrderId = new Map<string, TrackedOrder>();
const finalized = new Set<string>(); // nullifiers we've already attested for this process
let _wallet: ethers.Wallet | null = null;
let _ws: WebSocket | null = null;
let _authCreds: ClobCreds | null = null; // derived CLOB L2 creds for the user-channel subscribe
let _connecting = false;
let _stopped = false;
let _reconnectAttempts = 0;
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _reconcileTimer: ReturnType<typeof setInterval> | null = null;
let _pingTimer: ReturnType<typeof setInterval> | null = null;

const RECONCILE_INTERVAL_MS = 30_000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
// Polymarket's CLOB user-channel idle-times-out a socket that doesn't periodically PING (the cause of
// the regular ~2-minute "websocket closed — reconnecting" churn, which drops live limit-order fill
// tracking). Send a lightweight "PING" well inside that window; the server replies "PONG" (a non-JSON
// frame that handleMessage already ignores).
const PING_INTERVAL_MS = 10_000;

function stopPing(): void {
  if (_pingTimer) { clearInterval(_pingTimer); _pingTimer = null; }
}

function startPing(ws: WebSocket): void {
  stopPing();
  _pingTimer = setInterval(() => {
    if (_ws === ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send("PING"); } catch { /* next reconnect handles it */ }
    } else {
      stopPing();
    }
  }, PING_INTERVAL_MS);
}

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
    if (alreadyAttested(o.side, o.nullifier)) {
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
  stopPing();
  try { _ws?.close(); } catch { /* ignore */ }
  _ws = null;
}

/**
 * Register a freshly-submitted resting order for fill tracking. Persists it (crash
 * recovery), adds it to the in-memory registry, and (re)subscribes so the websocket
 * receives its fills.
 */
export function trackOrder(o: TrackedOrder): void {
  if (finalized.has(o.nullifier) || alreadyAttested(o.side, o.nullifier)) return;
  persist(o);
  byOrderId.set(o.orderID, o);
  logger.info({ nullifier: o.nullifier, orderID: o.orderID, conditionId: o.conditionId }, "tracking resting order");
  subscribe();
  // In case the order already filled between submit and subscribe.
  void reconcileOne(o);
}

/**
 * Is there a still-active (non-finalized) tracked order for this bet? Used by the event-listener
 * catchup to avoid RE-SUBMITTING a resting GTC/GTD limit order (which has no terminal attestation
 * yet, so the attestation-based dedup alone would re-place it on restart → duplicate order).
 */
export function isOrderTracked(nullifier: string): boolean {
  if (finalized.has(nullifier)) return false;
  for (const o of byOrderId.values()) if (o.nullifier === nullifier) return true;
  return false;
}

/** The still-active tracked order for this bet, or undefined. */
export function getTrackedOrder(nullifier: string): TrackedOrder | undefined {
  if (finalized.has(nullifier)) return undefined;
  for (const o of byOrderId.values()) if (o.nullifier === nullifier) return o;
  return undefined;
}

/**
 * User-requested cancel of a RESTING limit order. Cancels it on the CLOB so it can no longer
 * fill, then reconciles the TRUE final state — the fill tracker finalizes to FAILED (zero fill,
 * reclaimable) or PARTIAL (refund remainder). It NEVER blind-attests FAILED: if the cancel raced
 * a fill, reconcile/ws sees the real fill and attests accordingly, so a filled bet can't be
 * reclaimed (no double-spend). Returns "finalized" if a terminal attestation now exists, else
 * "cancel-requested" (the ws will finalize when the terminal message arrives).
 */
/**
 * Authoritative fill check for an order via the CLOB trade history (used after a cancel, when
 * getOrder returns nothing because canceled orders are purged). Sums `matched_amount` across all
 * trades on the order's market where this order appears as a maker. Returns 1e6-scaled
 * filled/spent, or null if the trade query failed (caller then leaves it unfinalized — never a
 * blind FAILED). A genuine zero-fill order simply has no matching maker entries → {filled:0}.
 */
async function confirmFillViaTrades(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  clobClient: any,
  o: TrackedOrder,
): Promise<{ filled: bigint; spent: bigint } | null> {
  try {
    const trades = await clobClient.getTrades({ market: o.conditionId });
    if (!Array.isArray(trades)) return null;
    const oid = o.orderID.toLowerCase();
    let shares = 0;
    let spent = 0;
    for (const t of trades) {
      for (const mo of (t?.maker_orders ?? [])) {
        if (String(mo?.order_id ?? "").toLowerCase() === oid) {
          const amt = Number(mo?.matched_amount ?? 0);
          const price = Number(mo?.price ?? 0);
          if (Number.isFinite(amt) && amt > 0) {
            shares += amt;
            spent += amt * (Number.isFinite(price) ? price : 0);
          }
        }
      }
    }
    return { filled: BigInt(Math.round(shares * 1e6)), spent: BigInt(Math.round(spent * 1e6)) };
  } catch (err) {
    logger.warn({ err: String(err), orderID: o.orderID }, "cancel-bet: getTrades fill-check failed");
    return null;
  }
}

export async function cancelTrackedOrder(
  nullifier: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  clobClient: any,
): Promise<"finalized" | "cancel-requested"> {
  if (finalized.has(nullifier)) return "finalized";
  const order = getTrackedOrder(nullifier);
  if (!order) return "finalized";
  // SELL closes attest SOLD, which coexists with the bet's FILLED outcome — anti-join side-aware.
  if (alreadyAttested(order.side, nullifier)) return "finalized";
  if (clobClient && order.orderID) {
    try {
      await clobClient.cancelOrder({ orderID: order.orderID });
      logger.info({ nullifier, orderID: order.orderID }, "cancel-bet: cancelled resting order on CLOB");
    } catch (err) {
      logger.warn({ err: String(err), orderID: order.orderID }, "cancel-bet: CLOB cancelOrder failed (still confirming)");
    }
    // Confirm the TRUE final fill from the real CLOB order state and finalize deterministically
    // — a zero-fill cancel emits NO user-channel message, so we can't wait for the ws. Only
    // finalize once the order is no longer live (cancel took effect); otherwise leave it (no
    // blind-FAILED → a still-live order that could fill is never marked reclaimable).
    try {
      const od = await clobClient.getOrder(order.orderID);
      const st = String((od && od.status) || "").toUpperCase();
      if (st && st !== "LIVE" && st !== "DELAYED" && st !== "OPEN") {
        const matched = Number((od && od.size_matched) || 0); // shares filled before cancel
        const orig = Number((od && od.original_size) || 0);
        const priceFrac = Number((od && od.price) || 0)
          || (order.side === "SELL" ? Number(order.sellLimitPrice) / 1e6 : Number(order.price) / 1e8);
        const filled = BigInt(Math.round(matched * 1e6));
        const spent = BigInt(Math.round(matched * priceFrac * 1e6));
        const status = matched <= 0 ? "cancelled" : orig > 0 && matched >= orig ? "matched" : "partial";
        await finalize(order, status, filled, spent);
        logger.info({ nullifier, orderStatus: st, matched, mapped: status }, "cancel-bet: finalized from CLOB order state");
        return "finalized";
      }
      logger.warn({ nullifier, orderStatus: st }, "cancel-bet: getOrder empty/live — falling back to trade history");
    } catch (err) {
      logger.warn({ err: String(err), orderID: order.orderID }, "cancel-bet: getOrder failed — falling back to trade history");
    }
    // getOrder couldn't confirm (canceled orders are purged from the orders endpoint → empty
    // status). The cancel already succeeded, so the order is off the book and its fill is final.
    // getTrades is the AUTHORITATIVE fill record: sum matched_amount across trades where this
    // order is a maker. No match → genuine zero fill → FAILED (safe reclaim, no double-spend).
    const fill = await confirmFillViaTrades(clobClient, order);
    if (fill) {
      const status = fill.filled <= 0n ? "cancelled" : "partial"; // attestTerminal maps full→FILLED
      await finalize(order, status, fill.filled, fill.spent);
      logger.info(
        { nullifier, filled: fill.filled.toString(), spent: fill.spent.toString(), mapped: status },
        "cancel-bet: finalized from trade history",
      );
      return "finalized";
    }
  }
  await reconcileOne(order); // dev/mock backstop; the ws also delivers the terminal state
  return finalized.has(nullifier) || alreadyAttested(order.side, nullifier) ? "finalized" : "cancel-requested";
}

/**
 * Cancel every still-tracked resting order for a market that just RESOLVED. A resolved
 * market can no longer fill, so any order still on the book is dead — finalize it as a
 * zero-fill cancellation (→ FAILED attestation) so the depositor can reclaim the full
 * stake via betCancellationCredit. Idempotent + single-write: an order that already
 * filled (FILLED attestation) is unaffected. Called by the settlement resolver on
 * ConditionResolution. Handles GTC (never expires) and any GTD still resting at resolution.
 */
export function cancelOrdersForMarket(conditionId: string): void {
  for (const o of Array.from(byOrderId.values())) {
    if (finalized.has(o.nullifier)) continue;
    if (!sameMarket(o.conditionId, conditionId)) continue;
    logger.info(
      { nullifier: o.nullifier, orderID: o.orderID, conditionId },
      "market resolved — cancelling still-resting order (reclaimable)",
    );
    void finalize(o, "cancelled", 0n, 0n);
  }
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
    startPing(ws); // keepalive — stops Polymarket's idle close (~2-min reconnect churn)
    // Load the DERIVED CLOB creds before subscribing — the static env creds are rejected by
    // Polymarket, which closed the socket on every connect (no fills ever tracked).
    void (async () => {
      try { _authCreds = await getClobCreds(); } catch { /* subscribe falls back to env */ }
      subscribe();
      void reconcileAll();
    })();
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
    stopPing();
    if (_ws === ws) _ws = null;
    if (!_stopped) { logger.warn("user-channel websocket closed — reconnecting"); scheduleReconnect(); }
  });

  ws.on("error", (err: Error) => {
    _connecting = false;
    stopPing();
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
  // Use the derived creds (loaded on connect); fall back to env creds only if not yet available.
  const creds = _authCreds ?? { key: config.polyApiKey, secret: config.polySecret, passphrase: config.polyPassphrase };
  const msg = {
    type: "user",
    auth: { apiKey: creds.key, secret: creds.secret, passphrase: creds.passphrase },
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
  // Production best-effort: size_matched is matched shares (decimal). Derive spent at the
  // committed (= ceiling) price as a pool-safe upper bound. o.price is 1e8-scaled and filled is
  // 1e6-scaled, so divide by 1e8 to land in micro-USDC. (Was /1e6 — a latent 100× overstatement
  // that would have made spent exceed bet_amount and revert on-chain; matches the cancel path above.)
  // TODO(FC-4): validate against the real user-channel field names + executed cost when available.
  if (m.size_matched !== undefined) {
    const shares = typeof m.size_matched === "number" ? m.size_matched : parseFloat(String(m.size_matched));
    const filled = BigInt(Math.floor(shares * 1e6));
    // SELL close: `spent` carries PROCEEDS at the (conservative) sell limit price — a SELL fills at
    // ≥ its limit, so crediting filled×sellLimitPrice never over-credits the pool. sellLimitPrice is
    // 1e6-scaled. BUY: `spent` is cost at the committed ceiling price (o.price is 1e8-scaled).
    const spent = o.side === "SELL"
      ? (filled * o.sellLimitPrice) / 1_000_000n
      : (filled * o.price) / 100_000_000n;
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
  // Apply the crossed-portion CLOB taker fee captured at submit (0 for a pure resting maker fill):
  // a BUY pays it (add to spent → not refunded); a SELL has it deducted from proceeds (for a SELL,
  // `spent` carries the proceeds). This is what closes fee holes (a) crossing-limit BUY and (b) the
  // crossing-limit SELL — the FAK SELL nets its fee inline in submitMarketSellOrder.
  let adjSpent = spent;
  if (o.takerFeeUsd > 0n) {
    adjSpent = o.side === "SELL"
      ? (spent > o.takerFeeUsd ? spent - o.takerFeeUsd : 0n)
      : spent + o.takerFeeUsd;
  }
  logger.info(
    { nullifier: o.nullifier, orderID: o.orderID, status, filled: filled.toString(), spent: adjSpent.toString(), takerFeeUsd: o.takerFeeUsd.toString() },
    "limit order reached terminal state — attesting",
  );
  await attestTerminal(_wallet, o, status, filled, adjSpent);
  byOrderId.delete(o.orderID);
  unpersist(o.nullifier);
}

/**
 * One-shot reconcile of a tracked resting order's terminal state — the backstop that catches a
 * fill the user-channel websocket missed (so a filled order is never left "pending").
 *
 * Production: query the AUTHENTICATED CLOB (the mock {filledShares,spentAmount} shape does not
 * exist there, and a FILLED order is PURGED from the orders endpoint, so getOrder alone misses
 * fills). (1) If getOrder reports a terminal (non-live) status, finalize from size_matched. (2) If
 * getOrder is empty/purged, the trade history is authoritative — finalize ONLY on a confirmed
 * fill. A still-LIVE order is left alone (a partial-while-live is not terminal), and a zero-fill
 * from an empty getOrder is NOT blind-FAILED (could be a transient miss on a live order) — the ws,
 * the next reconcile, GTD expiry, or market resolution handle those.
 *
 * Dev/mock: the mock CLOB serves GET /order/:id with {status, filledShares, spentAmount}.
 */
async function reconcileOne(o: TrackedOrder): Promise<void> {
  if (finalized.has(o.nullifier)) return;
  const clobHost = httpHost();
  const isMock = clobHost.includes("localhost") || clobHost.includes("127.0.0.1");

  if (!isMock) {
    if (!_wallet) return;
    try {
      // Lazy import avoids the static orderBuilder ↔ wsFillTracker cycle (orderBuilder imports
      // trackOrder from here). Reuses the cached, derived-L2-cred ClobClient.
      const { getOrCreateClobClient } = await import("./orderBuilder.js");
      const clobClient = await getOrCreateClobClient(_wallet);
      if (!clobClient) return;

      const od = await clobClient.getOrder(o.orderID).catch(() => null);
      const st = String(od?.status ?? "").toUpperCase();
      const liveOnBook = st === "LIVE" || st === "DELAYED" || st === "OPEN";
      if (od && st && !liveOnBook) {
        // Terminal order state — derive the fill from size_matched / original_size (same as the
        // cancel path). attestTerminal then maps full→FILLED, strict-partial→PARTIAL, zero→FAILED.
        const matched = Number(od.size_matched ?? 0);
        const orig = Number(od.original_size ?? 0);
        const priceFrac = Number(od.price ?? 0) || Number(o.price) / 1e8;
        const filled = BigInt(Math.round(matched * 1e6));
        const spent = BigInt(Math.round(matched * priceFrac * 1e6));
        const status = matched <= 0 ? "cancelled" : orig > 0 && matched >= orig ? "matched" : "partial";
        await finalize(o, status, filled, spent);
        return;
      }
      if (od && liveOnBook) return; // still resting on the book — not terminal, wait

      // getOrder empty: matched/cancelled orders are purged, so trade history is the authoritative
      // fill record (this is the FILLED-GTC case the ws/old reconcile missed → "pending"). Finalize
      // ONLY on a confirmed fill; a zero-fill here is ambiguous, so leave it (no false FAILED).
      const fill = await confirmFillViaTrades(clobClient, o);
      if (fill && fill.filled > 0n) {
        await finalize(o, "partial", fill.filled, fill.spent); // attestTerminal maps full→FILLED
      }
    } catch (err) {
      logger.debug({ err, orderID: o.orderID }, "reconcileOne (prod) failed (best-effort)");
    }
    return;
  }

  // Dev/mock backstop: the mock CLOB serves the fill amounts directly.
  try {
    const res = await fetch(`${clobHost}/order/${o.orderID}`);
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
