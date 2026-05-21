/**
 * Mock Polymarket market database for battle-testing.
 *
 * Matches real Polymarket CLOB API response format exactly:
 * - Market-level fields from GET /markets/:condition_id
 * - Token/position fields
 * - Orderbook fields from GET /book?token_id=...
 * - Settlement fields for resolved markets
 */

// --- Polymarket CLOB API types (mirrors real API) ---

export interface PolymarketToken {
  token_id: string;      // CTF ERC-1155 token ID (outcome position ID)
  outcome: string;       // "Yes" | "No"
  price: number;         // 0–1 (mid-price)
  winner: boolean;
}

export interface PolymarketMarket {
  // Core identity
  condition_id: string;   // bytes32 hex — CTF conditionId
  question_id: string;    // bytes32 hex
  market_slug: string;
  question: string;

  // Status
  active: boolean;
  closed: boolean;
  accepting_orders: boolean;
  accepting_order_timestamp: string | null; // ISO-8601

  // Financial
  minimum_order_size: number;      // USDC dollars
  minimum_tick_size: number;       // price increment
  maker_base_fee: number;
  taker_base_fee: number;

  // Collateral
  collateral_token: string;        // USDC address on Polygon

  // Positions
  tokens: PolymarketToken[];

  // Resolution
  end_date_iso: string | null;
  game_start_time: string | null;
  seconds_delay: number;
  payout_numerators: number[] | null;   // null = unresolved
  payout_denominator: number | null;

  // Liquidity snapshot (from orderbook)
  volume: number;         // total USDC traded
  volume_24hr: number;
  liquidity: number;      // USDC on book

  // Internal metadata
  _category: MarketCategory;
  _description: string;
}

export type MarketCategory =
  | "active_balanced"
  | "active_skewed_yes"
  | "active_skewed_no"
  | "active_illiquid"
  | "resolved_yes"
  | "resolved_no"
  | "resolved_na"
  | "adversarial_na_fake"
  | "adversarial_stale"
  | "adversarial_bad_payout";

// Deterministic but realistic-looking 32-byte hex IDs
function conditionId(n: number): string {
  return "0x" + n.toString(16).padStart(64, "0");
}
function questionId(n: number): string {
  return "0x" + (n + 0x1000).toString(16).padStart(64, "0");
}
function tokenId(n: number): string {
  // Token IDs on CTF are large uint256 values
  return (BigInt("0xdeadbeef0000") + BigInt(n)).toString();
}

const USDC_POLYGON = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

function market(
  n: number,
  overrides: Partial<PolymarketMarket> & { _category: MarketCategory; _description: string }
): PolymarketMarket {
  return {
    condition_id: conditionId(n),
    question_id: questionId(n),
    market_slug: `mock-market-${n}`,
    question: `Will mock event ${n} happen?`,
    active: true,
    closed: false,
    accepting_orders: true,
    accepting_order_timestamp: "2025-01-01T00:00:00Z",
    minimum_order_size: 5,
    minimum_tick_size: 0.01,
    maker_base_fee: 0,
    taker_base_fee: 0,
    collateral_token: USDC_POLYGON,
    tokens: [
      { token_id: tokenId(n * 2), outcome: "Yes", price: 0.50, winner: false },
      { token_id: tokenId(n * 2 + 1), outcome: "No", price: 0.50, winner: false },
    ],
    end_date_iso: "2026-12-31T23:59:59Z",
    game_start_time: null,
    seconds_delay: 0,
    payout_numerators: null,
    payout_denominator: null,
    volume: 10_000,
    volume_24hr: 500,
    liquidity: 2_000,
    ...overrides,
  };
}

// --- Active Markets ---

export const ACTIVE_MARKETS: PolymarketMarket[] = [
  // Near-50/50 pricing (liquid, balanced)
  market(1, {
    question: "Will the Federal Reserve cut rates in Q3 2026?",
    market_slug: "fed-rate-cut-q3-2026",
    tokens: [
      { token_id: tokenId(2), outcome: "Yes", price: 0.52, winner: false },
      { token_id: tokenId(3), outcome: "No", price: 0.48, winner: false },
    ],
    volume: 2_500_000,
    volume_24hr: 85_000,
    liquidity: 350_000,
    _category: "active_balanced",
    _description: "High-volume balanced market at 52/48",
  }),

  market(2, {
    question: "Will Bitcoin exceed $150k by end of 2026?",
    market_slug: "btc-150k-2026",
    tokens: [
      { token_id: tokenId(4), outcome: "Yes", price: 0.49, winner: false },
      { token_id: tokenId(5), outcome: "No", price: 0.51, winner: false },
    ],
    volume: 5_000_000,
    volume_24hr: 210_000,
    liquidity: 800_000,
    _category: "active_balanced",
    _description: "Very high volume, near 50/50 — prime for large bets",
  }),

  market(3, {
    question: "Will the 2026 US midterms flip the Senate?",
    market_slug: "senate-flip-2026",
    tokens: [
      { token_id: tokenId(6), outcome: "Yes", price: 0.50, winner: false },
      { token_id: tokenId(7), outcome: "No", price: 0.50, winner: false },
    ],
    volume: 1_200_000,
    volume_24hr: 30_000,
    liquidity: 200_000,
    _category: "active_balanced",
    _description: "Exactly 50/50 — edge case for price-based shares calculation",
  }),

  // Heavily skewed Yes (0.80+)
  market(4, {
    question: "Will the Eiffel Tower still be standing in 2027?",
    market_slug: "eiffel-tower-2027",
    tokens: [
      { token_id: tokenId(8), outcome: "Yes", price: 0.98, winner: false },
      { token_id: tokenId(9), outcome: "No", price: 0.02, winner: false },
    ],
    volume: 50_000,
    volume_24hr: 500,
    liquidity: 10_000,
    _category: "active_skewed_yes",
    _description: "98% Yes — tiny No side, shares calculation uses extreme price",
  }),

  market(5, {
    question: "Will any G7 country have AI-generated legislation by end of 2026?",
    market_slug: "g7-ai-legislation-2026",
    tokens: [
      { token_id: tokenId(10), outcome: "Yes", price: 0.82, winner: false },
      { token_id: tokenId(11), outcome: "No", price: 0.18, winner: false },
    ],
    volume: 320_000,
    volume_24hr: 12_000,
    liquidity: 60_000,
    _category: "active_skewed_yes",
    _description: "82% Yes — good test for shares arithmetic at non-round prices",
  }),

  // Heavily skewed No (0.20-)
  market(6, {
    question: "Will cold fusion be commercially viable by 2027?",
    market_slug: "cold-fusion-2027",
    tokens: [
      { token_id: tokenId(12), outcome: "Yes", price: 0.03, winner: false },
      { token_id: tokenId(13), outcome: "No", price: 0.97, winner: false },
    ],
    volume: 25_000,
    volume_24hr: 100,
    liquidity: 5_000,
    _category: "active_skewed_no",
    _description: "3% Yes — buying Yes gives 33x leverage on a tiny price",
  }),

  market(7, {
    question: "Will SpaceX land humans on Mars before 2027?",
    market_slug: "spacex-mars-2027",
    tokens: [
      { token_id: tokenId(14), outcome: "Yes", price: 0.05, winner: false },
      { token_id: tokenId(15), outcome: "No", price: 0.95, winner: false },
    ],
    volume: 180_000,
    volume_24hr: 2_000,
    liquidity: 30_000,
    _category: "active_skewed_no",
    _description: "5% Yes — shares calculation: 100 USDC at 5 cents = 2000 shares",
  }),

  // Illiquid market
  market(8, {
    question: "Will a new ISO standard for blockchain be published in 2026?",
    market_slug: "iso-blockchain-2026",
    tokens: [
      { token_id: tokenId(16), outcome: "Yes", price: 0.35, winner: false },
      { token_id: tokenId(17), outcome: "No", price: 0.65, winner: false },
    ],
    volume: 800,
    volume_24hr: 0,
    liquidity: 200,
    _category: "active_illiquid",
    _description: "Very illiquid — FOK orders likely to fail (signing layer must call reportFOKFailure)",
  }),

  market(9, {
    question: "Will a specific obscure municipality pass a zoning law?",
    market_slug: "obscure-zoning-law",
    minimum_order_size: 5,
    tokens: [
      { token_id: tokenId(18), outcome: "Yes", price: 0.50, winner: false },
      { token_id: tokenId(19), outcome: "No", price: 0.50, winner: false },
    ],
    volume: 150,
    volume_24hr: 0,
    liquidity: 50,
    _category: "active_illiquid",
    _description: "Essentially no liquidity — FOK fill impossible; cancellation path must be tested",
  }),
];

// --- Resolved Markets ---

export const RESOLVED_MARKETS: PolymarketMarket[] = [
  // Resolved YES
  market(100, {
    question: "Did the 2025 NFL Super Bowl occur?",
    market_slug: "nfl-superbowl-2025",
    active: false,
    closed: true,
    accepting_orders: false,
    accepting_order_timestamp: null,
    tokens: [
      { token_id: tokenId(200), outcome: "Yes", price: 1.0, winner: true },
      { token_id: tokenId(201), outcome: "No", price: 0.0, winner: false },
    ],
    payout_numerators: [1_000_000, 0],  // full payout to Yes
    payout_denominator: 1_000_000,
    volume: 10_000_000,
    volume_24hr: 0,
    liquidity: 0,
    _category: "resolved_yes",
    _description: "YES resolution — payout_per_share = 1e6 (full pUSD)",
  }),

  market(101, {
    question: "Did Bitcoin close above $100k in January 2026?",
    market_slug: "btc-100k-jan-2026",
    active: false,
    closed: true,
    accepting_orders: false,
    accepting_order_timestamp: null,
    tokens: [
      { token_id: tokenId(202), outcome: "Yes", price: 1.0, winner: true },
      { token_id: tokenId(203), outcome: "No", price: 0.0, winner: false },
    ],
    payout_numerators: [1_000_000, 0],
    payout_denominator: 1_000_000,
    volume: 4_500_000,
    volume_24hr: 0,
    liquidity: 0,
    _category: "resolved_yes",
    _description: "YES resolution with large volume — settlement credit path",
  }),

  // Resolved NO
  market(102, {
    question: "Will the 2026 World Cup be cancelled?",
    market_slug: "world-cup-cancelled-2026",
    active: false,
    closed: true,
    accepting_orders: false,
    accepting_order_timestamp: null,
    tokens: [
      { token_id: tokenId(204), outcome: "Yes", price: 0.0, winner: false },
      { token_id: tokenId(205), outcome: "No", price: 1.0, winner: true },
    ],
    payout_numerators: [0, 1_000_000],  // full payout to No
    payout_denominator: 1_000_000,
    volume: 750_000,
    volume_24hr: 0,
    liquidity: 0,
    _category: "resolved_no",
    _description: "NO resolution — Yes position pays 0; No pays full",
  }),

  market(103, {
    question: "Did the Fed raise rates in Q1 2026?",
    market_slug: "fed-raise-q1-2026",
    active: false,
    closed: true,
    accepting_orders: false,
    accepting_order_timestamp: null,
    tokens: [
      { token_id: tokenId(206), outcome: "Yes", price: 0.0, winner: false },
      { token_id: tokenId(207), outcome: "No", price: 1.0, winner: true },
    ],
    payout_numerators: [0, 1_000_000],
    payout_denominator: 1_000_000,
    volume: 1_200_000,
    volume_24hr: 0,
    liquidity: 0,
    _category: "resolved_no",
    _description: "NO resolution — tests that vault doesn't pay out Yes positions",
  }),

  // Resolved N/A (all-zero numerators)
  market(104, {
    question: "Will an event that never happened happen?",
    market_slug: "impossible-event-na",
    active: false,
    closed: true,
    accepting_orders: false,
    accepting_order_timestamp: null,
    tokens: [
      { token_id: tokenId(208), outcome: "Yes", price: 0.0, winner: false },
      { token_id: tokenId(209), outcome: "No", price: 0.0, winner: false },
    ],
    payout_numerators: [0, 0],  // N/A resolution — all zero
    payout_denominator: 1_000_000,
    volume: 200_000,
    volume_24hr: 0,
    liquidity: 0,
    _category: "resolved_na",
    _description: "N/A resolution — all zeros; naCancellationCredit path must trigger",
  }),

  market(105, {
    question: "Did an earthquake above M9 hit a G7 country in 2025?",
    market_slug: "g7-earthquake-m9-2025",
    active: false,
    closed: true,
    accepting_orders: false,
    accepting_order_timestamp: null,
    tokens: [
      { token_id: tokenId(210), outcome: "Yes", price: 0.0, winner: false },
      { token_id: tokenId(211), outcome: "No", price: 0.0, winner: false },
    ],
    payout_numerators: [0, 0],
    payout_denominator: 1_000_000,
    volume: 90_000,
    volume_24hr: 0,
    liquidity: 0,
    _category: "resolved_na",
    _description: "N/A — second test case for all-zero numerators",
  }),
];

// --- Adversarial Markets ---

export const ADVERSARIAL_MARKETS: PolymarketMarket[] = [
  // Fake N/A claim: market actually resolved YES but attacker claims N/A
  market(200, {
    question: "Did something definitely happen?",
    market_slug: "definitely-happened",
    active: false,
    closed: true,
    accepting_orders: false,
    accepting_order_timestamp: null,
    tokens: [
      { token_id: tokenId(400), outcome: "Yes", price: 1.0, winner: true },
      { token_id: tokenId(401), outcome: "No", price: 0.0, winner: false },
    ],
    payout_numerators: [1_000_000, 0],  // YES, NOT N/A
    payout_denominator: 1_000_000,
    volume: 500_000,
    volume_24hr: 0,
    liquidity: 0,
    _category: "adversarial_na_fake",
    _description: "Resolved YES — attacker tries to claim N/A credit; vault must revert because payout_numerators != [0,0]",
  }),

  // Market with non-standard denominator (uncommon but possible)
  market(201, {
    question: "Will event 201 happen?",
    market_slug: "event-201",
    active: false,
    closed: true,
    accepting_orders: false,
    accepting_order_timestamp: null,
    tokens: [
      { token_id: tokenId(402), outcome: "Yes", price: 1.0, winner: true },
      { token_id: tokenId(403), outcome: "No", price: 0.0, winner: false },
    ],
    payout_numerators: [500_000, 0],   // 50% payout (unusual partial resolution)
    payout_denominator: 500_000,       // denominator matches — effectively 100% of denom
    volume: 300_000,
    volume_24hr: 0,
    liquidity: 0,
    _category: "adversarial_bad_payout",
    _description: "Non-standard denominator — payout_per_share calculation must use actual denominator",
  }),

  // Stale/ghost market (condition_id not in CTF, lookup would fail)
  market(202, {
    question: "Will an event that was never registered happen?",
    market_slug: "ghost-market-unregistered",
    condition_id: "0x" + "dead".repeat(16),  // random non-existent conditionId
    active: false,
    closed: true,
    accepting_orders: false,
    accepting_order_timestamp: null,
    tokens: [
      { token_id: tokenId(404), outcome: "Yes", price: 0.5, winner: false },
      { token_id: tokenId(405), outcome: "No", price: 0.5, winner: false },
    ],
    payout_numerators: null,
    payout_denominator: null,
    volume: 0,
    volume_24hr: 0,
    liquidity: 0,
    _category: "adversarial_stale",
    _description: "Ghost condition_id — lookup on CTF contract returns 0; all operations should revert",
  }),

  // market_id / condition_id mismatch (bet on market A, credit on market B)
  market(203, {
    question: "Shadow market for cross-market attack",
    market_slug: "shadow-market-203",
    active: false,
    closed: true,
    accepting_orders: false,
    accepting_order_timestamp: null,
    tokens: [
      { token_id: tokenId(406), outcome: "Yes", price: 1.0, winner: true },
      { token_id: tokenId(407), outcome: "No", price: 0.0, winner: false },
    ],
    payout_numerators: [1_000_000, 0],
    payout_denominator: 1_000_000,
    volume: 50_000,
    volume_24hr: 0,
    liquidity: 0,
    _category: "adversarial_bad_payout",
    _description: "Attacker places bet on market 100 then submits settlement proof with market_id from market 203 (different payout); Vault must reject because market_id in BetRecord must match",
  }),
];

export const ALL_MARKETS: PolymarketMarket[] = [
  ...ACTIVE_MARKETS,
  ...RESOLVED_MARKETS,
  ...ADVERSARIAL_MARKETS,
];

// Helper: get a market token ID for Yes position
export function yesTokenId(m: PolymarketMarket): string {
  const yes = m.tokens.find((t) => t.outcome === "Yes");
  if (!yes) throw new Error(`No Yes token in market ${m.condition_id}`);
  return yes.token_id;
}
