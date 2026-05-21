/**
 * POST /order
 * Simulates FOK order submission. Behavior controlled via /admin/set-behavior.
 *
 * fill      → { status: "MATCHED", success: true }
 * no_fill   → { status: "UNMATCHED", errorMsg: "FOK_ORDER_NOT_FILLED" }
 * error_403 → HTTP 403 { error: "user is not allowed to trade" }
 * rate_limit→ HTTP 429 { error: "Too Many Requests" }
 * timeout   → response never sent (tests timeout/abort handling)
 */

import { Router, Request, Response } from "express";
import { state } from "../state";
import { v4 as uuidv4 } from "uuid";

export const ordersRouter = Router();

ordersRouter.post("/", (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const order = (body.order ?? {}) as Record<string, unknown>;

  const received = {
    timestamp: new Date().toISOString(),
    tokenId: String(order.tokenId ?? ""),
    price: String(order.price ?? ""),
    size: String(order.makerAmount ?? ""),
    side: String(order.side ?? ""),
    orderType: String(body.orderType ?? ""),
    body,
  };
  state.ordersReceived.push(received);

  const orderId = `0x${uuidv4().replace(/-/g, "")}`;
  const now = new Date().toISOString();

  console.log(
    `[clob] POST /order #${state.ordersReceived.length}` +
    ` tokenId=${received.tokenId.slice(0, 10)}...` +
    ` behavior=${state.fillBehavior}`
  );

  // Timeout: hang and never respond (the signing layer must have its own timeout)
  if (state.fillBehavior === "timeout") {
    console.log("[clob] timeout mode — not responding");
    return;
  }

  const respond = (): void => {
    switch (state.fillBehavior) {
      case "fill":
        res.json({
          success: true,
          errorMsg: "",
          orderID: orderId,
          transactTime: now,
          status: "MATCHED",
        });
        break;

      case "no_fill":
        res.json({
          success: false,
          errorMsg: "FOK_ORDER_NOT_FILLED",
          orderID: orderId,
          transactTime: now,
          status: "UNMATCHED",
        });
        break;

      case "error_403":
        res.status(403).json({
          error: "user is not allowed to trade",
        });
        break;

      case "rate_limit":
        res.status(429).json({
          error: "Too Many Requests",
          retryAfter: 60,
        });
        break;
    }
  };

  if (state.responseDelayMs > 0) {
    setTimeout(respond, state.responseDelayMs);
  } else {
    respond();
  }
});
