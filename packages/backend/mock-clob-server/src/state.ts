/**
 * Mutable state for the mock CLOB server.
 * All test control goes through /admin endpoints which mutate this object.
 */

export type FillBehavior =
  | "fill"         // order fills successfully
  | "no_fill"      // FOK order not filled (normal market failure)
  | "error_403"    // account flagged / banned — triggers circuit breaker
  | "timeout"      // server hangs, no response (tests timeout handling)
  | "rate_limit";  // 429 Too Many Requests

export interface ReceivedOrder {
  timestamp: string;
  tokenId: string;
  price: string;
  size: string;
  side: string;
  orderType: string;
  body: Record<string, unknown>;
}

export interface SettledMarket {
  conditionId: string;
  payoutNumerators: number[];
  payoutDenominator: number;
  settledAt: string;
  /** YES won when numerators[0] > 0; NO won when numerators[1] > 0; N/A when all zero */
  outcome: "YES" | "NO" | "NA";
}

export interface ServerState {
  fillBehavior: FillBehavior;
  heartbeatCount: number;
  heartbeatId: string;
  ordersReceived: ReceivedOrder[];
  authCallCount: number;
  responseDelayMs: number;
  nextOrderId: number;
  /** Live settlement records, keyed by conditionId (lowercase hex) */
  settledMarkets: Record<string, SettledMarket>;
}

export const state: ServerState = {
  fillBehavior: "fill",
  heartbeatCount: 0,
  heartbeatId: "hb-0000-0000-0000",
  ordersReceived: [],
  authCallCount: 0,
  responseDelayMs: 0,
  nextOrderId: 1,
  settledMarkets: {},
};

export function resetState(): void {
  state.fillBehavior = "fill";
  state.heartbeatCount = 0;
  state.heartbeatId = "hb-0000-0000-0000";
  state.ordersReceived = [];
  state.authCallCount = 0;
  state.responseDelayMs = 0;
  state.nextOrderId = 1;
  state.settledMarkets = {};
}
