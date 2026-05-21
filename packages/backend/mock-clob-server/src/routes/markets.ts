/**
 * GET /markets/:condition_id
 * Returns market data in real Polymarket CLOB API format.
 * Serves from our fixture database when the condition_id matches,
 * falls back to a generic active market for unknown IDs.
 */

import { Router, Request, Response } from "express";

export const marketsRouter = Router();

// Inline a small set of well-known mock market condition IDs
// (these match what MockDeploy.s.sol sets up in MockCTF)
const KNOWN_MARKETS: Record<string, object> = {
  // keccak256("market_resolved_yes") — matches MockCTF setup
  "0xd37af6c9f14de8a5e27fc4e855e74b37b25ef8d8b8b52d32b11e80c2a32c0dc5": {
    condition_id: "0xd37af6c9f14de8a5e27fc4e855e74b37b25ef8d8b8b52d32b11e80c2a32c0dc5",
    question: "Mock: Resolved YES market",
    active: false,
    closed: true,
    accepting_orders: false,
    tokens: [
      { token_id: "1001", outcome: "Yes", price: 1.0, winner: true },
      { token_id: "1002", outcome: "No", price: 0.0, winner: false },
    ],
    payout_numerators: [1_000_000, 0],
    payout_denominator: 1_000_000,
  },
  // keccak256("market_resolved_na")
  "0x4f7d39b51d63d8c1b1e2a4b6e3c8d2f9a5b7e1c4d6f8a2b3e5c7d9f1a3b5e7c": {
    condition_id: "0x4f7d39b51d63d8c1b1e2a4b6e3c8d2f9a5b7e1c4d6f8a2b3e5c7d9f1a3b5e7c",
    question: "Mock: Resolved N/A market",
    active: false,
    closed: true,
    accepting_orders: false,
    tokens: [
      { token_id: "2001", outcome: "Yes", price: 0.0, winner: false },
      { token_id: "2002", outcome: "No", price: 0.0, winner: false },
    ],
    payout_numerators: [0, 0],
    payout_denominator: 1_000_000,
  },
};

marketsRouter.get("/:condition_id", (req: Request, res: Response) => {
  const { condition_id } = req.params;
  console.log(`[clob] GET /markets/${condition_id}`);

  const known = KNOWN_MARKETS[condition_id.toLowerCase()];
  if (known) {
    res.json(known);
    return;
  }

  // Generic active market for any unknown condition_id
  res.json({
    condition_id,
    question: `Mock market for ${condition_id.slice(0, 10)}...`,
    active: true,
    closed: false,
    accepting_orders: true,
    accepting_order_timestamp: new Date().toISOString(),
    minimum_order_size: 5,
    minimum_tick_size: 0.01,
    maker_base_fee: 0,
    taker_base_fee: 0,
    collateral_token: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    tokens: [
      { token_id: "9001", outcome: "Yes", price: 0.50, winner: false },
      { token_id: "9002", outcome: "No", price: 0.50, winner: false },
    ],
    end_date_iso: "2026-12-31T23:59:59Z",
    payout_numerators: null,
    payout_denominator: null,
    volume: 100_000,
    volume_24hr: 5_000,
    liquidity: 20_000,
  });
});
