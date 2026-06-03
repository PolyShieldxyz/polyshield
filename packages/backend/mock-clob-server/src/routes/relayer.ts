/**
 * POST /relayer/wallet-batch
 *
 * Mock twin of the Polymarket builder relayer. Accepts a WALLET batch
 *   { calls: [{ target, value, data }] }
 * and submits it on-chain to the MockDepositWallet proxy via executeBatch, signed
 * by the relayer key. This lets the signing layer's DepositWalletExecutor run the
 * exact same code path here (mock) and against the real relayer (production).
 *
 * Closes audit H2 (relayer WALLET batch) for the local stack.
 */

import { Router, Request, Response } from "express";
import { ethers } from "ethers";

export const relayerRouter = Router();

const PROXY_ABI = [
  "function executeBatch((address target, uint256 value, bytes data)[] calls) external",
];

interface BatchCall {
  target: string;
  value?: string;
  data: string;
}

relayerRouter.post("/wallet-batch", async (req: Request, res: Response) => {
  const body = req.body as { calls?: BatchCall[] };
  const calls = Array.isArray(body.calls) ? body.calls : [];

  const proxy = process.env["DEPOSIT_WALLET_PROXY"] ?? process.env["DEPOSIT_WALLET_ADDRESS"];
  const relayerKey = process.env["RELAYER_PRIVATE_KEY"];
  const rpcUrl =
    process.env["POLYGON_RPC_URL"] ?? process.env["ANVIL_RPC_URL"] ?? "http://127.0.0.1:8545";

  if (!proxy || !relayerKey) {
    res.status(500).json({ ok: false, error: "DEPOSIT_WALLET_PROXY / RELAYER_PRIVATE_KEY not set" });
    return;
  }
  if (calls.length === 0) {
    res.json({ ok: true, txHash: null, note: "empty batch" });
    return;
  }

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const signer = new ethers.Wallet(relayerKey, provider);
    const wallet = new ethers.Contract(proxy, PROXY_ABI, signer);

    const structCalls = calls.map((c) => ({
      target: c.target,
      value: BigInt(c.value ?? "0"),
      data: c.data,
    }));

    const tx = await wallet.executeBatch(structCalls);
    const receipt = await tx.wait(1);
    console.log(`[relayer] WALLET batch (${calls.length} calls) → ${tx.hash}`);
    res.json({ ok: true, txHash: receipt?.hash ?? tx.hash });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[relayer] WALLET batch failed: ${msg}`);
    res.status(502).json({ ok: false, error: msg });
  }
});
