/**
 * Admin router — lets integration tests control server behavior at runtime.
 *
 * All endpoints are POST to make them easy to call with curl or fetch.
 * No authentication — only reachable on localhost.
 *
 * Endpoints:
 *   POST /admin/set-behavior   { behavior: FillBehavior }
 *   POST /admin/set-delay      { delayMs: number }
 *   POST /admin/reset          (no body)
 *   GET  /admin/state          returns full ServerState snapshot
 */

import { Router, Request, Response } from "express";
import { state, resetState, FillBehavior } from "./state";

export const adminRouter = Router();

adminRouter.post("/set-behavior", (req: Request, res: Response) => {
  const { behavior } = req.body as { behavior?: FillBehavior };
  const valid: FillBehavior[] = ["fill", "no_fill", "error_403", "timeout", "rate_limit"];
  if (!behavior || !valid.includes(behavior)) {
    res.status(400).json({ error: `behavior must be one of: ${valid.join(", ")}` });
    return;
  }
  state.fillBehavior = behavior;
  console.log(`[admin] fill behavior → ${behavior}`);
  res.json({ ok: true, fillBehavior: state.fillBehavior });
});

adminRouter.post("/set-delay", (req: Request, res: Response) => {
  const { delayMs } = req.body as { delayMs?: number };
  if (typeof delayMs !== "number" || delayMs < 0) {
    res.status(400).json({ error: "delayMs must be a non-negative number" });
    return;
  }
  state.responseDelayMs = delayMs;
  console.log(`[admin] response delay → ${delayMs}ms`);
  res.json({ ok: true, responseDelayMs: state.responseDelayMs });
});

adminRouter.post("/reset", (_req: Request, res: Response) => {
  resetState();
  console.log("[admin] state reset");
  res.json({ ok: true });
});

adminRouter.get("/state", (_req: Request, res: Response) => {
  res.json(state);
});
