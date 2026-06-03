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

const PROXY_ABI = [
  "function executeBatch((address target, uint256 value, bytes data)[] calls) external",
];
const ERC20_TRANSFER_IFACE = new ethers.Interface([
  "function transfer(address to, uint256 amount) returns (bool)",
]);

/**
 * On a fill, debit `betAmount1e6` pUSD from the deposit-wallet proxy (the buying
 * power that was just-in-time funded). This makes fills genuinely consume the
 * residual buffer while no-fills leave it intact — mirroring how a real fill moves
 * pUSD out of the deposit wallet into the CTF exchange. Routed through the relayer
 * → proxy WALLET batch so the proxy itself is the payer. Fire-and-forget; any
 * failure (e.g. proxy not deployed in a legacy run) is non-fatal.
 */
export async function debitDepositWalletPusd(betAmount1e6: number): Promise<void> {
  const pusd = process.env["PUSD_ADDRESS"];
  const proxy = process.env["DEPOSIT_WALLET_PROXY"] ?? process.env["DEPOSIT_WALLET_ADDRESS"];
  const sink = process.env["CTF_ADDRESS"]; // MockCTF acts as the collateral escrow sink
  const relayerKey = process.env["RELAYER_PRIVATE_KEY"];
  const rpcUrl =
    process.env["POLYGON_RPC_URL"] ?? process.env["ANVIL_RPC_URL"] ?? "http://127.0.0.1:8545";

  if (!pusd || !proxy || !sink || !relayerKey) return;
  if (betAmount1e6 <= 0) return;

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const signer = new ethers.Wallet(relayerKey, provider);
    const wallet = new ethers.Contract(proxy, PROXY_ABI, signer);
    const data = ERC20_TRANSFER_IFACE.encodeFunctionData("transfer", [sink, BigInt(Math.floor(betAmount1e6))]);
    const tx = await wallet.executeBatch([{ target: pusd, value: 0n, data }]);
    await tx.wait(1);
    console.log(`[clob] debited proxy pUSD ${Math.floor(betAmount1e6)} (buffer consumed) via relayer batch`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[clob] proxy pUSD debit failed (non-fatal): ${msg}`);
  }
}

/**
 * Mint `shares1e6` CTF shares (1e6-scaled) of `tokenId` to the deposit wallet so
 * that the signing layer's redemption pipeline finds actual shares and exercises
 * the real pUSD → USDC → Vault path. Exported so the FC-4 limit-order admin
 * endpoint can mint exactly the partially/fully filled share count.
 */
export async function mintCTFShares(tokenId: string, shares1e6: number): Promise<void> {
  const ctfAddress = process.env["CTF_ADDRESS"];
  const depositWallet = process.env["DEPOSIT_WALLET_ADDRESS"];
  const deployerKey = process.env["DEPLOYER_PRIVATE_KEY"];
  const rpcUrl = process.env["POLYGON_RPC_URL"] ?? process.env["ANVIL_RPC_URL"] ?? "http://127.0.0.1:8545";

  if (!ctfAddress || !depositWallet || !deployerKey) {
    console.warn("[clob] mintCTFShares: missing CTF_ADDRESS / DEPOSIT_WALLET_ADDRESS / DEPLOYER_PRIVATE_KEY — skipping");
    return;
  }
  if (shares1e6 <= 0) return;

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const signer = new ethers.Wallet(deployerKey, provider);
    const ctf = new ethers.Contract(ctfAddress, MOCK_CTF_ABI, signer);
    const positionId = BigInt(tokenId); // tokenId is the position id (uint256 as hex string)

    const tx = await ctf.mintShares(depositWallet, positionId, BigInt(Math.floor(shares1e6)));
    await tx.wait(1);
    console.log(
      `[clob] mintShares: depositWallet=${depositWallet.slice(0, 8)}... ` +
      `positionId=${tokenId.slice(0, 10)}... shares=${Math.floor(shares1e6)}`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[clob] mintShares failed (non-fatal): ${msg}`);
  }
}

/**
 * When a FOK order fills, mint CTF shares ≈ makerAmount / price (both 1e6 units).
 */
async function mintCTFSharesOnFill(
  tokenId: string,
  makerAmountStr: string,
  priceStr: string
): Promise<void> {
  const betAmount = Math.floor(parseFloat(makerAmountStr) * 1e6);
  const price = parseFloat(priceStr);
  const sharesAmount = price > 0 ? Math.floor(betAmount / price) : betAmount;
  await mintCTFShares(tokenId, sharesAmount);
  // Consume the JIT-funded pUSD buffer on the proxy (Option-3 fidelity).
  await debitDepositWalletPusd(betAmount);
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
    ` type=${received.orderType} behavior=${state.fillBehavior}`
  );

  // FC-4: GTC/GTD limit orders rest on the book. Return status "live" and record
  // the resting order; a fill is driven later via POST /admin/limit-fill and the
  // signing layer polls GET /order/:id for the terminal state. FOK is unchanged.
  const orderTypeUpper = received.orderType.toUpperCase();
  if (orderTypeUpper === "GTC" || orderTypeUpper === "GTD") {
    state.restingOrders[orderId] = {
      orderID: orderId,
      tokenId: received.tokenId,
      side: received.side.toUpperCase(),
      orderType: orderTypeUpper,
      price: received.price,
      size: received.size,
      createdAt: now,
      status: "live",
      filledShares: 0,
      spentAmount: 0,
    };
    res.json({ success: true, errorMsg: "", orderID: orderId, transactTime: now, status: "live" });
    return;
  }

  // FAK (fill-and-kill): a market order that fills immediately and kills the remainder.
  // Synchronous like FOK, but its result can be a PARTIAL fill (driven by partialFillBps
  // under the "partial_fill" behavior). Returns filledShares/spentAmount (1e6-scaled) so
  // the signing layer can attest PARTIAL with the exact amounts.
  if (orderTypeUpper === "FAK") {
    if (state.fillBehavior === "timeout") {
      console.log("[clob] FAK timeout mode — not responding");
      return;
    }
    const respondFak = (): void => {
      const betAmount1e6 = Math.floor(parseFloat(received.size) * 1e6);
      const price = parseFloat(received.price);
      const fullShares = price > 0 ? Math.floor(betAmount1e6 / price) : betAmount1e6;
      const isSell = received.side.toUpperCase() === "SELL";
      switch (state.fillBehavior) {
        case "fill":
          if (!isSell) void mintCTFSharesOnFill(received.tokenId, received.size, received.price);
          res.json({
            success: true, errorMsg: "", orderID: orderId, transactTime: now,
            status: "MATCHED", filledShares: fullShares, spentAmount: betAmount1e6,
          });
          break;
        case "partial_fill": {
          const bps = Math.min(9999, Math.max(1, Math.floor(state.partialFillBps)));
          let spent = Math.floor((betAmount1e6 * bps) / 10000);
          let filled = price > 0 ? Math.floor(spent / price) : spent;
          // Force a STRICT partial (Vault.partialFillCredit rejects filled>=expected or spent>=bet).
          if (spent <= 0) spent = 1;
          if (spent >= betAmount1e6) spent = Math.max(1, betAmount1e6 - 1);
          if (filled <= 0) filled = 1;
          if (filled >= fullShares) filled = Math.max(1, fullShares - 1);
          if (!isSell) {
            void mintCTFShares(received.tokenId, filled);
            void debitDepositWalletPusd(spent);
          }
          res.json({
            success: true, errorMsg: "", orderID: orderId, transactTime: now,
            status: "PARTIAL", filledShares: filled, spentAmount: spent,
          });
          break;
        }
        case "no_fill":
          res.json({
            success: false, errorMsg: "FAK_ORDER_NOT_FILLED", orderID: orderId, transactTime: now,
            status: "UNMATCHED", filledShares: 0, spentAmount: 0,
          });
          break;
        case "error_403":
          res.status(403).json({ error: "user is not allowed to trade" });
          break;
        case "rate_limit":
          res.status(429).json({ error: "Too Many Requests", retryAfter: 60 });
          break;
      }
    };
    if (state.responseDelayMs > 0) setTimeout(respondFak, state.responseDelayMs);
    else respondFak();
    return;
  }

  // Timeout: hang and never respond (the signing layer must have its own timeout)
  if (state.fillBehavior === "timeout") {
    console.log("[clob] timeout mode — not responding");
    return;
  }

  const respond = (): void => {
    switch (state.fillBehavior) {
      case "fill":
        // Mint CTF shares asynchronously — fire-and-forget, does not block the response.
        // Only BUY orders acquire shares; a SELL (FC-1 position close) realizes proceeds
        // and must not mint, so the signing layer's reportSold reflects the sale.
        if (received.side.toUpperCase() !== "SELL") {
          void mintCTFSharesOnFill(received.tokenId, received.size, received.price);
        }
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

/**
 * GET /order/:id  (FC-4)
 * Returns the current lifecycle state of a resting GTC/GTD limit order. The
 * signing layer polls this until the order reaches a terminal status
 * (matched / partial / cancelled) and then maps it to one operator report.
 */
ordersRouter.get("/:id", (req: Request, res: Response) => {
  const order = state.restingOrders[req.params.id];
  if (!order) {
    res.status(404).json({ error: "order not found" });
    return;
  }
  res.json(order);
});
