/**
 * Token binding — which Polymarket token may the operator trade for a given on-chain bet?
 *
 * The circuits leave `market_id`, `position_id` and `outcome_side` unconstrained and the Vault stores them without
 * relating them to one another, while settlement pays out according to (market_id, outcome_side). The ONLY thing
 * tying the traded token to the settled market is therefore this operator-side derivation. Rules:
 *
 *   1. The token is ALWAYS derived from (market_id, outcome_side) via the market registry. The user-chosen
 *      `position_id` is never trusted in production.
 *   2. outcome_side must be 0 (YES) or 1 (NO) — the registry mirrors binary markets only.
 *   3. If the registry has no row for the market (production), FAIL CLOSED: place no order. The caller attests
 *      FAILED so the stake is reclaimed (bet) / leaves the position untouched (close).
 *   4. Only in mock mode (local CLOB, empty registry) the synthetic on-chain ids are used.
 *
 * Pure functions (no DB / network) so the policy is unit-testable.
 */

export interface RegistryHit {
  tokenId: string;
  conditionId: string;
}

export type BuyDecision =
  | { action: "trade"; tokenId: string; conditionId: string; source: "registry" | "mock-onchain" }
  | { action: "reject"; reason: "outcome_side_out_of_range" | "market_not_in_registry" };

export class UnboundTokenError extends Error {
  constructor(public reason: string) {
    super(`token binding refused: ${reason}`);
  }
}

export function isMockClobHost(host: string | undefined): boolean {
  const h = host ?? "https://clob.polymarket.com";
  return h.includes("localhost") || h.includes("127.0.0.1");
}

export function decideBuyToken(args: {
  marketId: string;
  positionId: string;
  outcomeSide: number;
  resolved: RegistryHit | null;
  mock: boolean;
}): BuyDecision {
  if (!Number.isInteger(args.outcomeSide) || args.outcomeSide < 0 || args.outcomeSide > 1) {
    return { action: "reject", reason: "outcome_side_out_of_range" };
  }
  if (args.resolved && args.resolved.tokenId) {
    return { action: "trade", tokenId: args.resolved.tokenId, conditionId: args.resolved.conditionId, source: "registry" };
  }
  if (args.mock) {
    return { action: "trade", tokenId: args.positionId, conditionId: args.marketId, source: "mock-onchain" };
  }
  return { action: "reject", reason: "market_not_in_registry" };
}

/** Close (SELL) path: same policy; throws instead of returning a decision. */
export function decideCloseToken(args: {
  requestPositionId: string;
  outcomeSide: number | null;
  resolved: RegistryHit | null;
  mock: boolean;
}): { tokenId: string; conditionId: string } {
  if (args.outcomeSide !== null && (!Number.isInteger(args.outcomeSide) || args.outcomeSide < 0 || args.outcomeSide > 1)) {
    throw new UnboundTokenError("outcome_side_out_of_range");
  }
  if (args.resolved && args.resolved.tokenId) {
    return { tokenId: args.resolved.tokenId, conditionId: args.resolved.conditionId };
  }
  if (args.mock) return { tokenId: args.requestPositionId, conditionId: "" };
  throw new UnboundTokenError("market_not_in_registry");
}
