/**
 * POST /auth/api-key
 * Simulates Polymarket L2 credential derivation.
 * In production this validates an L1 EIP-712 signature; here it always succeeds.
 */

import { Router, Request, Response } from "express";
import { state } from "../state";

export const authRouter = Router();

authRouter.post("/api-key", (req: Request, res: Response) => {
  state.authCallCount++;
  console.log(`[clob] POST /auth/api-key (call #${state.authCallCount})`);

  // Real Polymarket response shape
  res.json({
    apiKey: "mock-api-key-0000",
    secret: "mock-secret-0000",
    passphrase: "mock-passphrase-0000",
  });
});
