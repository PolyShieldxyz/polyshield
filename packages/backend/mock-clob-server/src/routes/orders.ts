/**
 * POST /order
 * Simulates FOK order submission. Behavior controlled via /admin/set-behavior.
 *
 * fill      → { status: "MATCHED", success: true }  + mints CTF shares to depositWallet
 * no_fill   → { status: "UNMATCHED", errorMsg: "FOK_ORDER_NOT_FILLED" }
 * error_403 → HTTP 403 { error: "user is not allowed to trade" }
 * rate_limit→ HTTP 429 { error: "Too Many Requests" }
 * timeout   → response never sent (tests timeout/abort handling)
 */

import { Router, Request, Response } from "express";
import { ethers } from "ethers";
import { state } from "../state";
import { v4 as uuidv4 } from "uuid";

export const ordersRouter = Router();

const MOCK_CTF_ABI = [
  "function mintShares(address account, uint256 id, uint256 amount) external",
];

/**
 * When a FOK order fills, mint CTF shares to the deposit wallet so that the
 * signing layer's redemption pipeline finds actual shares and exercises the real
 * pUSD → USDC → Vault path instead of the mockInfuseVaultUsdc shortcut.
 *
 * sharesAmount ≈ makerAmount / price (both in USDC, converted to 1e6 units).
 */
async function mintCTFSharesOnFill(
  tokenId: string,
  makerAmountStr: string,
  priceStr: string
): Promise<void> {
  const ctfAddress = process.env["CTF_ADDRESS"];
  const depositWallet = process.env["DEPOSIT_WALLET_ADDRESS"];
  const deployerKey = process.env["DEPLOYER_PRIVATE_KEY"];
  const rpcUrl = process.env["POLYGON_RPC_URL"] ?? process.env["ANVIL_RPC_URL"] ?? "http://127.0.0.1:8545";

  if (!ctfAddress || !depositWallet || !deployerKey) {
    console.warn("[clob] mintCTFSharesOnFill: missing CTF_ADDRESS / DEPOSIT_WALLET_ADDRESS / DEPLOYER_PRIVATE_KEY — skipping");
    return;
  }

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const signer = new ethers.Wallet(deployerKey, provider);
    const ctf = new ethers.Contract(ctfAddress, MOCK_CTF_ABI, signer);

    // Convert decimal USDC amounts to micro-USDC (1e6 units).
    const betAmount = Math.floor(parseFloat(makerAmountStr) * 1e6);
    const price = parseFloat(priceStr);
    const sharesAmount = price > 0 ? Math.floor(betAmount / price) : betAmount;
    const sharesAmountBigInt = BigInt(sharesAmount);

    // tokenId is the position id (uint256 as hex string).
    const positionId = BigInt(tokenId);

    const tx = await ctf.mintShares(depositWallet, positionId, sharesAmountBigInt);
    await tx.wait(1);
    console.log(
      `[clob] mintShares: depositWallet=${depositWallet.slice(0, 8)}... ` +
      `positionId=${tokenId.slice(0, 10)}... shares=${sharesAmount}`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[clob] mintShares failed (non-fatal): ${msg}`);
  }
}

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
        // Mint CTF shares asynchronously — fire-and-forget, does not block the response.
        void mintCTFSharesOnFill(received.tokenId, received.size, received.price);
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
