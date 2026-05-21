/**
 * GET /markets/:condition_id
 * Returns market data in real Polymarket CLOB API format.
 *
 * Priority order:
 *  1. Live settlements triggered via POST /admin/settle-market (in server state)
 *  2. Static fixture markets that match MockDeploy.s.sol pre-seeded CTF state
 *  3. Generic active market for any unknown condition_id
 */

import { Router, Request, Response } from "express";
import { state } from "../state";

export const marketsRouter = Router();

function resolvedMarket(
  conditionId: string,
  question: string,
  payoutNumerators: number[],
  payoutDenominator: number,
  yesTokenId: string,
  noTokenId: string,
): object {
  const yesWon = payoutNumerators[0] > 0;
  const noWon = (payoutNumerators[1] ?? 0) > 0;
  return {
    condition_id: conditionId,
    question_id: conditionId,
    question,
    description: "",
    market_slug: `mock-market-${conditionId.slice(2, 10)}`,
    active: false,
    closed: true,
    archived: false,
    accepting_orders: false,
    accepting_order_timestamp: null,
    minimum_order_size: 5,
    minimum_tick_size: 0.01,
    maker_base_fee: 0,
    taker_base_fee: 0,
    collateral_token: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    tokens: [
      {
        token_id: yesTokenId,
        outcome: "Yes",
        price: yesWon ? 1.0 : 0.0,
        winner: yesWon,
      },
      {
        token_id: noTokenId,
        outcome: "No",
        price: noWon ? 1.0 : 0.0,
        winner: noWon,
      },
    ],
    payout_numerators: payoutNumerators,
    payout_denominator: payoutDenominator,
    volume: 100_000,
    volume_24hr: 0,
    liquidity: 0,
    end_date_iso: new Date().toISOString(),
  };
}

marketsRouter.get("/:condition_id", (req: Request, res: Response) => {
  const { condition_id } = req.params;
  const key = condition_id.toLowerCase();
  console.log(`[clob] GET /markets/${condition_id.slice(0, 12)}...`);

  // 1. Live admin-triggered settlement takes highest priority
  const live = state.settledMarkets[key];
  if (live) {
    res.json(
      resolvedMarket(
        condition_id,
        `Mock settled market (${live.outcome})`,
        live.payoutNumerators,
        live.payoutDenominator,
        "9001",
        "9002",
      ),
    );
    return;
  }

  // 2. Static fixtures matching MockDeploy.s.sol pre-seeded markets
  //    keccak256("market_resolved_yes")
  if (key === "0xd37af6c9f14de8a5e27fc4e855e74b37b25ef8d8b8b52d32b11e80c2a32c0dc5") {
    res.json(
      resolvedMarket(condition_id, "Mock: Resolved YES market", [1_000_000, 0], 1_000_000, "1001", "1002"),
    );
    return;
  }
  //    keccak256("market_resolved_na")
  if (key === "0x4f7d39b51d63d8c1b1e2a4b6e3c8d2f9a5b7e1c4d6f8a2b3e5c7d9f1a3b5e7c") {
    res.json(
      resolvedMarket(condition_id, "Mock: Resolved N/A market", [0, 0], 1_000_000, "2001", "2002"),
    );
    return;
  }

  // 3. Generic active market for any unknown condition_id
  res.json({
    condition_id,
    question_id: condition_id,
    question: `Mock market for ${condition_id.slice(0, 10)}...`,
    description: "",
    market_slug: `mock-market-${condition_id.slice(2, 10)}`,
    active: true,
    closed: false,
    archived: false,
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
