/**
 * Admin router — lets integration tests control server behavior at runtime.
 *
 * All endpoints are POST to make them easy to call with curl or fetch.
 * No authentication — only reachable on localhost.
 *
 * Endpoints:
 *   POST /admin/set-behavior      { behavior: FillBehavior }
 *   POST /admin/set-delay         { delayMs: number }
 *   POST /admin/reset             (no body)
 *   GET  /admin/state             returns full ServerState snapshot
 *   POST /admin/settle-market     { conditionId, payoutNumerators, payoutDenominator? }
 *     → calls MockCTF.setPayoutNumerators + setPayoutDenominator on Anvil,
 *       which emits ConditionResolution so the indexer detects settlement.
 *       Requires env: CTF_ADDRESS, DEPLOYER_PRIVATE_KEY (POLYGON_RPC_URL optional, defaults to http://127.0.0.1:8545)
 */

import { Router, Request, Response } from "express";
import { ethers } from "ethers";
import { state, resetState, FillBehavior, SettledMarket } from "./state";

export const adminRouter = Router();

// Minimal ABI for the MockCTF settlement calls
const MOCK_CTF_ABI = [
  "function setPayoutNumerators(bytes32 conditionId, uint256[] calldata numerators) external",
  "function setPayoutDenominator(bytes32 conditionId, uint256 denominator) external",
];

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

/**
 * POST /admin/settle-market
 *
 * Body: {
 *   conditionId: string          // bytes32 hex, e.g. "0xabc..."
 *   payoutNumerators: number[]   // e.g. [1000000, 0] for YES win
 *   payoutDenominator?: number   // default 1_000_000
 * }
 *
 * Effect:
 *  1. Calls MockCTF.setPayoutDenominator + setPayoutNumerators on Anvil
 *     → MockCTF emits ConditionResolution → indexer detects settlement
 *  2. Records the settlement in server state so /markets/:id returns resolved data
 */
adminRouter.post("/settle-market", (async (req: Request, res: Response) => {
  const { conditionId, payoutNumerators, payoutDenominator = 1_000_000 } =
    req.body as {
      conditionId?: string;
      payoutNumerators?: number[];
      payoutDenominator?: number;
    };

  if (!conditionId || !conditionId.startsWith("0x")) {
    res.status(400).json({ error: "conditionId must be a 0x-prefixed bytes32 hex string" });
    return;
  }
  if (!Array.isArray(payoutNumerators) || payoutNumerators.length === 0) {
    res.status(400).json({ error: "payoutNumerators must be a non-empty array of numbers" });
    return;
  }

  const ctfAddress = process.env["CTF_ADDRESS"];
  const rpcUrl = process.env["POLYGON_RPC_URL"] ?? process.env["ANVIL_RPC_URL"] ?? "http://127.0.0.1:8545";
  const deployerKey = process.env["DEPLOYER_PRIVATE_KEY"];

  if (!ctfAddress || !deployerKey) {
    res.status(500).json({
      error: "CTF_ADDRESS and DEPLOYER_PRIVATE_KEY env vars required for on-chain settlement",
    });
    return;
  }

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const signer = new ethers.Wallet(deployerKey, provider);
    const ctf = new ethers.Contract(ctfAddress, MOCK_CTF_ABI, signer);

    // Fetch nonce once and manually increment — prevents the race where ethers.js
    // signs both transactions before the first one is mined and assigns both nonce N.
    const nonce = await provider.getTransactionCount(signer.address);

    // Set denominator first (order doesn't matter on-chain but explicit is clearer)
    await (await ctf.setPayoutDenominator(conditionId, payoutDenominator, { nonce })).wait();
    // setPayoutNumerators emits ConditionResolution — indexer will pick this up
    const tx = await ctf.setPayoutNumerators(conditionId, payoutNumerators, { nonce: nonce + 1 });
    const receipt = await tx.wait();

    // Determine outcome label
    let outcome: SettledMarket["outcome"] = "NA";
    if (payoutNumerators[0] > 0) outcome = "YES";
    else if (payoutNumerators.length > 1 && payoutNumerators[1] > 0) outcome = "NO";

    const settled: SettledMarket = {
      conditionId: conditionId.toLowerCase(),
      payoutNumerators,
      payoutDenominator,
      settledAt: new Date().toISOString(),
      outcome,
    };
    state.settledMarkets[conditionId.toLowerCase()] = settled;

    console.log(
      `[admin] settled market ${conditionId.slice(0, 10)}... outcome=${outcome} ` +
      `numerators=${JSON.stringify(payoutNumerators)} tx=${receipt?.hash}`
    );

    res.json({ ok: true, settlement: settled, txHash: receipt?.hash });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[admin] settle-market failed: ${msg}`);
    res.status(500).json({ error: msg });
  }
}) as (req: Request, res: Response) => void);
