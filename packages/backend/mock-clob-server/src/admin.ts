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
 *   POST /admin/report-filled     { nullifier: "0x..." }
 *     → dev escape hatch: directly calls Vault.reportFilled(nullifier) via the operator key.
 *       Use when the signing layer missed a BetAuthorized event and the bet is stuck ACTIVE.
 */

import { Router, Request, Response } from "express";
import { ethers } from "ethers";
import { state, resetState, FillBehavior, SettledMarket } from "./state";
import { mintCTFShares } from "./routes/orders";
import { broadcastOrderUpdate } from "./ws";

export const adminRouter = Router();

// API-011: optional admin-token guard. This router stays LOOPBACK-ONLY and must
// NEVER be exposed on a public interface. When DEV_ADMIN_TOKEN is set, every
// /admin/* call must present a matching `x-admin-token` header (or
// `Authorization: Bearer <token>`); when unset we allow (dev convenience) but
// warn so the relaxed posture is visible in logs.
let warnedNoAdminToken = false;
adminRouter.use((req: Request, res: Response, next) => {
  const expected = process.env["DEV_ADMIN_TOKEN"];
  if (!expected) {
    if (!warnedNoAdminToken) {
      warnedNoAdminToken = true;
      console.warn("[admin] DEV_ADMIN_TOKEN unset — /admin/* is unauthenticated (loopback-only dev mode)");
    }
    next();
    return;
  }
  const headerToken = req.header("x-admin-token");
  const auth = req.header("authorization");
  const bearer = auth && auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
  if (headerToken === expected || bearer === expected) {
    next();
    return;
  }
  res.status(401).json({ error: "unauthorized" });
});

// Minimal ABI for the MockCTF settlement calls
const MOCK_CTF_ABI = [
  "function setPayoutNumerators(bytes32 conditionId, uint256[] calldata numerators) external",
  "function setPayoutDenominator(bytes32 conditionId, uint256 denominator) external",
];

const VAULT_ABI = [
  "function resolveMarket(bytes32 market_id) external",
  "function pendingCredit(bytes32 market_id, uint8 outcome_side) view returns (uint64)",
  "function reportFilled(bytes32 nullifier_of_bet) external",
  "function reportFOKFailure(bytes32 nullifier_of_bet) external",
];

adminRouter.post("/set-behavior", (req: Request, res: Response) => {
  const { behavior, partialFillBps } = req.body as { behavior?: FillBehavior; partialFillBps?: number };
  const valid: FillBehavior[] = ["fill", "partial_fill", "no_fill", "error_403", "timeout", "rate_limit"];
  if (!behavior || !valid.includes(behavior)) {
    res.status(400).json({ error: `behavior must be one of: ${valid.join(", ")}` });
    return;
  }
  state.fillBehavior = behavior;
  // Optional: control the FAK/partial fraction (basis points) used by "partial_fill".
  if (typeof partialFillBps === "number" && partialFillBps > 0 && partialFillBps < 10000) {
    state.partialFillBps = Math.floor(partialFillBps);
  }
  console.log(`[admin] fill behavior → ${behavior}${behavior === "partial_fill" ? ` (${state.partialFillBps}bps)` : ""}`);
  res.json({ ok: true, fillBehavior: state.fillBehavior, partialFillBps: state.partialFillBps });
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
  const vaultAddress = process.env["VAULT_CONTRACT_ADDRESS"];
  const rpcUrl = process.env["POLYGON_RPC_URL"] ?? process.env["ANVIL_RPC_URL"] ?? "http://127.0.0.1:8545";
  const deployerKey = process.env["DEPLOYER_PRIVATE_KEY"];
  const operatorKey = process.env["VAULT_EOA_PRIVATE_KEY"];

  if (!ctfAddress || !deployerKey) {
    res.status(500).json({
      error: "CTF_ADDRESS and DEPLOYER_PRIVATE_KEY env vars required for on-chain settlement",
    });
    return;
  }

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const deployer = new ethers.Wallet(deployerKey, provider);
    const ctf = new ethers.Contract(ctfAddress, MOCK_CTF_ABI, deployer);

    // Fetch nonce once and manually increment to avoid both txs getting nonce N.
    const nonce = await provider.getTransactionCount(deployer.address);

    // Set denominator first, then numerators (numerators emits ConditionResolution)
    await (await ctf.setPayoutDenominator(conditionId, payoutDenominator, { nonce })).wait();
    const ctfTx = await ctf.setPayoutNumerators(conditionId, payoutNumerators, { nonce: nonce + 1 });
    const ctfReceipt = await ctfTx.wait();

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

    // Directly call Vault.resolveMarket so pendingCredit is set immediately,
    // without waiting for the signing layer to process the ConditionResolution event.
    // This makes dev/test settlement reliable even if the signing layer is slow or crashed.
    let resolveMarketTxHash: string | undefined;
    if (vaultAddress && operatorKey && outcome !== "NA") {
      try {
        const operator = new ethers.Wallet(operatorKey, provider);
        const vault = new ethers.Contract(vaultAddress, VAULT_ABI, operator);
        const operatorNonce = await provider.getTransactionCount(operator.address);
        const resolveTx = await vault.resolveMarket(conditionId, { nonce: operatorNonce });
        const resolveReceipt = await resolveTx.wait();
        resolveMarketTxHash = resolveReceipt?.hash;
        console.log(
          `[admin] Vault.resolveMarket confirmed: conditionId=${conditionId.slice(0, 10)}... ` +
          `tx=${resolveMarketTxHash}`
        );
      } catch (vaultErr) {
        const vaultMsg = vaultErr instanceof Error ? vaultErr.message : String(vaultErr);
        console.warn(`[admin] Vault.resolveMarket failed (signing layer will retry via event): ${vaultMsg}`);
      }
    }

    console.log(
      `[admin] settled market ${conditionId.slice(0, 10)}... outcome=${outcome} ` +
      `numerators=${JSON.stringify(payoutNumerators)} ctfTx=${ctfReceipt?.hash}`
    );

    res.json({ ok: true, settlement: settled, ctfTxHash: ctfReceipt?.hash, resolveMarketTxHash });
  } catch (err) {
    // API-004: log full error server-side; return a generic message to the caller.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[admin] settle-market failed: ${msg}`);
    res.status(500).json({ error: "settle-market failed" });
  }
}) as (req: Request, res: Response) => void);

/**
 * POST /admin/limit-fill   (FC-4)
 *
 * Drives a resting GTC/GTD limit order to a terminal state for integration tests.
 * Body: {
 *   orderID?: string,          // target order; if omitted, the most recent live order for tokenId
 *   tokenId?: string,          // used to find the order when orderID is omitted
 *   terminal: "filled" | "partial" | "cancelled",
 *   filled_shares?: number,    // 1e6-scaled; required for "partial"
 *   spent_amount?: number      // 1e6-scaled; required for "partial"
 * }
 *
 * For "filled"/"partial" BUY orders, mints the filled CTF shares to the deposit
 * wallet (so the signing layer's reportFilled / reportPartialFill reflects real
 * holdings). The signing layer polls GET /order/:id and maps the terminal status.
 */
adminRouter.post("/limit-fill", (async (req: Request, res: Response) => {
  const { orderID, tokenId, terminal, filled_shares, spent_amount } = req.body as {
    orderID?: string;
    tokenId?: string;
    terminal?: "filled" | "partial" | "cancelled";
    filled_shares?: number;
    spent_amount?: number;
  };

  if (terminal !== "filled" && terminal !== "partial" && terminal !== "cancelled") {
    res.status(400).json({ error: 'terminal must be one of: "filled", "partial", "cancelled"' });
    return;
  }

  // Resolve the target resting order.
  let order = orderID ? state.restingOrders[orderID] : undefined;
  if (!order && tokenId) {
    const matches = Object.values(state.restingOrders)
      .filter((o) => o.tokenId === tokenId && o.status === "live");
    order = matches[matches.length - 1];
  }
  if (!order) {
    res.status(404).json({ error: "no matching resting order (provide orderID or a tokenId with a live order)" });
    return;
  }

  if (terminal === "cancelled") {
    order.status = "cancelled";
    order.filledShares = 0;
    order.spentAmount = 0;
  } else if (terminal === "filled") {
    const sizeMicro = Math.floor(parseFloat(order.size) * 1e6);
    const price = parseFloat(order.price);
    order.filledShares = price > 0 ? Math.floor(sizeMicro / price) : sizeMicro;
    order.spentAmount = sizeMicro;
    order.status = "matched";
  } else {
    // partial
    if (typeof filled_shares !== "number" || typeof spent_amount !== "number" || filled_shares <= 0 || spent_amount <= 0) {
      res.status(400).json({ error: "filled_shares and spent_amount (positive, 1e6-scaled) are required for terminal=partial" });
      return;
    }
    order.filledShares = Math.floor(filled_shares);
    order.spentAmount = Math.floor(spent_amount);
    order.status = "partial";
  }

  // Mint the filled shares for BUY orders so settlement/redemption finds real holdings.
  if (order.side === "BUY" && order.filledShares > 0) {
    await mintCTFShares(order.tokenId, order.filledShares);
  }

  // FC-4: push the terminal state to user-channel websocket subscribers (the signing
  // layer's wsFillTracker). The REST GET /order/:id still reflects the same state as a
  // reconcile backstop.
  broadcastOrderUpdate({
    orderID: order.orderID,
    tokenId: order.tokenId,
    status: order.status,
    filledShares: order.filledShares,
    spentAmount: order.spentAmount,
  });

  console.log(
    `[admin] limit-fill order=${order.orderID.slice(0, 10)}... → ${order.status} ` +
    `filledShares=${order.filledShares} spentAmount=${order.spentAmount}`
  );
  res.json({ ok: true, order });
}) as (req: Request, res: Response) => void);

/**
 * POST /admin/report-filled
 * Dev escape hatch: manually calls Vault.reportFilled(nullifier) using the operator key.
 * Use this when the signing layer missed a BetAuthorized event and the bet is stuck ACTIVE.
 *
 * Body: { nullifier: "0x..." }
 */
adminRouter.post("/report-filled", (async (req: Request, res: Response) => {
  const { nullifier } = req.body as { nullifier?: string };
  if (!nullifier || !nullifier.startsWith("0x")) {
    res.status(400).json({ error: "nullifier must be a 0x-prefixed hex string" });
    return;
  }

  const vaultAddress = process.env["VAULT_CONTRACT_ADDRESS"];
  const operatorKey = process.env["VAULT_EOA_PRIVATE_KEY"];
  const rpcUrl = process.env["POLYGON_RPC_URL"] ?? "http://127.0.0.1:8545";

  if (!vaultAddress || !operatorKey) {
    res.status(500).json({ error: "VAULT_CONTRACT_ADDRESS and VAULT_EOA_PRIVATE_KEY required" });
    return;
  }

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const operator = new ethers.Wallet(operatorKey, provider);
    const vault = new ethers.Contract(vaultAddress, VAULT_ABI, operator);
    const tx = await vault.reportFilled(nullifier);
    const receipt = await tx.wait(1);
    console.log(`[admin] reportFilled confirmed: nullifier=${nullifier.slice(0, 10)}... tx=${receipt?.hash}`);
    res.json({ ok: true, txHash: receipt?.hash });
  } catch (err) {
    // API-004: log full error server-side; return a generic message to the caller.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[admin] report-filled failed: ${msg}`);
    res.status(500).json({ error: "report-filled failed" });
  }
}) as (req: Request, res: Response) => void);
