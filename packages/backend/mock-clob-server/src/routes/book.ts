/**
 * GET /book?token_id=X
 * Returns a fake orderbook for the given token.
 * Liquidity depth varies by token_id prefix to simulate different market conditions.
 */

import { Router, Request, Response } from "express";

export const bookRouter = Router();

bookRouter.get("/", (req: Request, res: Response) => {
  const tokenId = String(req.query.token_id ?? "");
  console.log(`[clob] GET /book?token_id=${tokenId.slice(0, 16)}...`);

  // Deterministically vary liquidity based on token ID
  const tokenSeed = parseInt(tokenId.slice(-4), 16) || 0;
  const isIlliquid = tokenSeed % 7 === 0;  // ~14% of tokens are illiquid

  if (isIlliquid) {
    res.json({
      market: "mock-market",
      asset_id: tokenId,
      bids: [{ price: "0.49", size: "50.00" }],
      asks: [{ price: "0.51", size: "30.00" }],
      hash: "0x" + "0".repeat(64),
    });
    return;
  }

  res.json({
    market: "mock-market",
    asset_id: tokenId,
    bids: [
      { price: "0.50", size: "10000.00" },
      { price: "0.49", size: "25000.00" },
      { price: "0.48", size: "50000.00" },
    ],
    asks: [
      { price: "0.51", size: "8000.00" },
      { price: "0.52", size: "20000.00" },
      { price: "0.53", size: "40000.00" },
    ],
    hash: "0x" + "1".repeat(64),
  });
});
