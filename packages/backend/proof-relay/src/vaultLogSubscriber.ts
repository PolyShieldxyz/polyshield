/**
 * B1 — WebSocket log subscription as a LATENCY ACCELERATOR (never the source of truth).
 *
 * Opens one `eth_subscribe("logs", { address: [vault, tree] })` over a WS RPC and, on every relevant
 * log, NUDGES the existing cursor-based sync (merkle cache + event index) — the same nudge the relay
 * fires after its own tx confirms. The WS never feeds data directly: the authoritative ingestion stays
 * in the HTTP `syncNow()` (append-only, root-verified, cursor-persisted). So a dropped/flaky/lossy WS
 * can only cost LATENCY, not correctness — the slow HTTP reconcile + on-demand /merkle-path sync still
 * guarantee every leaf/event lands. This is why a free-tier WS is acceptable here.
 *
 * Robustness: ping/liveness probe, reconnect with backoff, and — critically — a full nudge on EVERY
 * (re)connect, so the cursor-based sync sweeps whatever was missed while the socket was down (gap
 * recovery). Entirely disabled unless POLYGON_WS_URL is set.
 */

import WebSocket from "ws";
import pino from "pino";

const logger = pino({ name: "vault-log-ws" });

const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];
const PING_INTERVAL_MS = 30_000;
// Coalesce a burst of logs (e.g. several vault events in one block) into a single syncNow().
const NUDGE_DEBOUNCE_MS = 250;

export interface VaultLogSubscriberOptions {
  wsUrl: string;
  /** Addresses whose logs signal new on-chain state: the Vault (events) + the Merkle tree (LeafInserted). */
  addresses: string[];
  /** Pull new state into the caches. Called debounced on a log, and once on every (re)connect (gap recovery). */
  onActivity: () => void;
}

let _ws: WebSocket | null = null;
let _stopped = false;
let _reconnectAttempts = 0;
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _pingTimer: ReturnType<typeof setInterval> | null = null;
let _nudgeTimer: ReturnType<typeof setTimeout> | null = null;
let _subId: string | null = null;
let _alive = false; // saw a message/pong since the last ping — else the socket is presumed dead

function debouncedNudge(onActivity: () => void): void {
  if (_nudgeTimer) return;
  _nudgeTimer = setTimeout(() => {
    _nudgeTimer = null;
    try { onActivity(); } catch (err) { logger.warn({ err: String(err) }, "onActivity nudge threw (ignored)"); }
  }, NUDGE_DEBOUNCE_MS);
}

function stopPing(): void {
  if (_pingTimer) { clearInterval(_pingTimer); _pingTimer = null; }
}

function startPing(ws: WebSocket): void {
  stopPing();
  _alive = true;
  _pingTimer = setInterval(() => {
    if (!_alive) {
      logger.warn("vault log ws: no pong/message since last ping — terminating to force reconnect");
      try { ws.terminate(); } catch { /* close handler reconnects */ }
      return;
    }
    _alive = false;
    try { ws.ping(); } catch { /* next interval / close handles it */ }
  }, PING_INTERVAL_MS);
}

function scheduleReconnect(opts: VaultLogSubscriberOptions): void {
  if (_stopped || _reconnectTimer) return;
  const delay = RECONNECT_DELAYS_MS[Math.min(_reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)];
  _reconnectAttempts += 1;
  _reconnectTimer = setTimeout(() => { _reconnectTimer = null; connect(opts); }, delay);
}

function connect(opts: VaultLogSubscriberOptions): void {
  let ws: WebSocket;
  try {
    ws = new WebSocket(opts.wsUrl);
  } catch (err) {
    logger.warn({ err: String(err) }, "vault log ws: construction failed — scheduling reconnect");
    scheduleReconnect(opts);
    return;
  }
  _ws = ws;
  _subId = null;

  ws.on("open", () => {
    _reconnectAttempts = 0;
    const req = { jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["logs", { address: opts.addresses }] };
    try { ws.send(JSON.stringify(req)); } catch (err) { logger.warn({ err: String(err) }, "vault log ws: subscribe send failed"); }
    startPing(ws);
    // GAP RECOVERY: sweep anything that landed while we were disconnected (cursor-based, bounded).
    debouncedNudge(opts.onActivity);
    logger.info({ addresses: opts.addresses }, "vault log ws: connected — subscribing to logs");
  });

  ws.on("message", (data: WebSocket.RawData) => {
    _alive = true;
    let msg: { id?: number; result?: unknown; error?: unknown; method?: string; params?: { subscription?: string } };
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.id === 1 && typeof msg.result === "string") {
      _subId = msg.result;
      logger.info({ subId: _subId }, "vault log ws: subscription active");
      return;
    }
    if (msg.id === 1 && msg.error) {
      // e.g. provider disables logs subscriptions — degrade gracefully to the HTTP reconcile.
      logger.error({ err: msg.error }, "vault log ws: eth_subscribe rejected — relying on HTTP reconcile only");
      return;
    }
    if (msg.method === "eth_subscription" && msg.params?.subscription === _subId) {
      debouncedNudge(opts.onActivity);
    }
  });

  ws.on("pong", () => { _alive = true; });

  ws.on("close", () => {
    stopPing();
    if (!_stopped) {
      logger.warn("vault log ws: closed — reconnecting");
      scheduleReconnect(opts);
    }
  });

  ws.on("error", (err: Error) => {
    logger.warn({ err: String(err) }, "vault log ws: socket error");
    // a "close" event follows an "error"; reconnect is scheduled there.
  });
}

export function startVaultLogSubscriber(opts: VaultLogSubscriberOptions): void {
  if (!opts.wsUrl) return;
  _stopped = false;
  _reconnectAttempts = 0;
  connect(opts);
}

export function stopVaultLogSubscriber(): void {
  _stopped = true;
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  if (_nudgeTimer) { clearTimeout(_nudgeTimer); _nudgeTimer = null; }
  stopPing();
  try { _ws?.close(); } catch { /* ignore */ }
  _ws = null;
}
