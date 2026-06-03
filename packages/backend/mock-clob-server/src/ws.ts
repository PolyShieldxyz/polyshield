/**
 * FC-4: mock Polymarket user-channel websocket (`/ws/user`).
 *
 * Mirrors the real `wss://ws-subscriptions-clob.polymarket.com/ws/user` shape closely
 * enough that the signing layer's production wsFillTracker runs against it unchanged in
 * local dev (`pnpm dev:mock`). Clients send a `{ type:"user", auth, markets }` subscribe;
 * the mock ignores auth/markets and simply broadcasts every order update to all clients
 * (the tracker matches on orderID). Terminal order updates are pushed from
 * POST /admin/limit-fill via broadcastOrderUpdate().
 */

import { WebSocketServer, WebSocket, RawData } from "ws";
import type { Server } from "http";

let _wss: WebSocketServer | null = null;

export function attachUserChannel(server: Server): void {
  _wss = new WebSocketServer({ server, path: "/ws/user" });
  _wss.on("connection", (socket: WebSocket) => {
    console.log("[clob-ws] user-channel client connected");
    socket.on("message", (data: RawData) => {
      try {
        const msg = JSON.parse(data.toString()) as { type?: string; markets?: unknown };
        if (msg?.type === "user") {
          console.log("[clob-ws] user-channel subscribe", JSON.stringify({ markets: msg.markets }));
        }
      } catch {
        /* ignore non-JSON frames */
      }
    });
    socket.on("close", () => console.log("[clob-ws] user-channel client disconnected"));
    socket.on("error", () => { /* ignore */ });
  });
  console.log("[clob-ws] user-channel websocket attached at /ws/user");
}

export interface OrderUpdate {
  orderID: string;
  tokenId: string;
  /** terminal order status: "matched" | "partial" | "cancelled" */
  status: string;
  /** 1e6-scaled shares filled */
  filledShares: number;
  /** 1e6-scaled collateral consumed */
  spentAmount: number;
}

/** Broadcast a Polymarket-shaped order-lifecycle update to all connected clients. */
export function broadcastOrderUpdate(u: OrderUpdate): void {
  if (!_wss) return;
  const payload = JSON.stringify({
    event_type: "order",
    type: "UPDATE",
    asset_id: u.tokenId,
    id: u.orderID,
    orderID: u.orderID,
    order_id: u.orderID,
    status: u.status,
    size_matched: u.filledShares / 1e6,
    // Mock convenience fields the tracker prefers when present (exact 1e6 amounts).
    filledShares: u.filledShares,
    spentAmount: u.spentAmount,
  });
  for (const client of _wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(payload); } catch { /* ignore */ }
    }
  }
}
