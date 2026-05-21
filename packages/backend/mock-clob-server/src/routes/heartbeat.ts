/**
 * POST /heartbeat
 * Cycles heartbeat_id to simulate the real Polymarket heartbeat protocol.
 * The signing layer must call this every 5s or the account goes inactive.
 */

import { Router, Request, Response } from "express";
import { state } from "../state";

export const heartbeatRouter = Router();

heartbeatRouter.post("/", (_req: Request, res: Response) => {
  state.heartbeatCount++;
  state.heartbeatId = `hb-${String(state.heartbeatCount).padStart(4, "0")}-mock`;
  console.log(`[clob] POST /heartbeat #${state.heartbeatCount} → ${state.heartbeatId}`);

  res.json({ heartbeat_id: state.heartbeatId });
});
