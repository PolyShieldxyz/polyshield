/**
 * Mock Polymarket CLOB API server.
 *
 * Runs on port 3001 (or PORT env var).
 * Routes mirror the real Polymarket API shape so the signing layer SDK
 * can be pointed at this server without any code changes — just set:
 *   POLY_API_URL=http://127.0.0.1:3001
 *
 * Test control is via /admin/* endpoints (no auth — localhost only).
 */

import express from "express";
import { authRouter } from "./routes/auth";
import { heartbeatRouter } from "./routes/heartbeat";
import { ordersRouter, expireDueGtdOrders } from "./routes/orders";
import { bookRouter } from "./routes/book";
import { marketsRouter } from "./routes/markets";
import { relayerRouter } from "./routes/relayer";
import { adminRouter } from "./admin";
import { attachUserChannel, broadcastOrderUpdate } from "./ws";

const PORT = Number(process.env.PORT ?? 3001);

export function createApp(): express.Express {
  const app = express();

  app.use(express.json());

  // Log every request (excluding /admin noise in CI — set QUIET=1 to suppress)
  app.use((req, _res, next) => {
    if (!process.env["QUIET"] || req.path.startsWith("/admin")) next();
    else {
      console.log(`[clob] ${req.method} ${req.path}`);
      next();
    }
  });

  // Polymarket CLOB API routes
  app.use("/auth", authRouter);
  app.use("/heartbeat", heartbeatRouter);
  app.use("/order", ordersRouter);
  app.use("/book", bookRouter);
  app.use("/markets", marketsRouter);
  // Mock builder relayer — submits deposit-wallet WALLET batches to the proxy.
  app.use("/relayer", relayerRouter);

  // Health check
  app.get("/health", (_req, res) => res.json({ ok: true }));

  // Admin control API (for integration tests)
  app.use("/admin", adminRouter);

  return app;
}

// Only start server when run directly (not when imported in tests)
if (require.main === module) {
  const app = createApp();
  const server = app.listen(PORT, "127.0.0.1", () => {
    console.log(`[mock-clob] listening on http://127.0.0.1:${PORT}`);
    console.log(`[mock-clob] control API: POST http://127.0.0.1:${PORT}/admin/set-behavior`);
    console.log(`[mock-clob]              GET  http://127.0.0.1:${PORT}/admin/state`);
    console.log(`[mock-clob]              POST http://127.0.0.1:${PORT}/admin/reset`);
  });
  // FC-4: user-channel websocket so the signing layer's production fill tracker is
  // exercised against the mock (set POLY_WS_URL=ws://127.0.0.1:PORT/ws/user).
  attachUserChannel(server);

  // GTD expiry sweep: a Good-Til-Date limit order that times out unfilled must leave the
  // book so the depositor can reclaim. Real Polymarket expires it and emits a cancellation
  // on the user channel; we simulate that here. Each newly-expired order is pushed to the
  // fill tracker (zero-fill → FAILED attestation → reclaimable). GET /order/:id also
  // lazy-expires as a reconcile backstop. 5s cadence keeps the ~1-minute GTD test prompt.
  setInterval(() => {
    for (const order of expireDueGtdOrders()) {
      broadcastOrderUpdate({
        orderID: order.orderID,
        tokenId: order.tokenId,
        status: order.status, // "expired"
        filledShares: order.filledShares,
        spentAmount: order.spentAmount,
      });
    }
  }, 5_000);
}
