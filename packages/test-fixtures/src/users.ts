/**
 * Mock user database for battle-testing and security testing.
 *
 * Covers: valid users across $0.1–$100k, boundary cases, adversarial wallets,
 * cap exploiters, address manipulation attempts, and ZK-level note attacks.
 */

export interface MockUser {
  id: string;
  address: string;
  usdcBalance: bigint;       // raw USDC (6 decimals), what they hold in wallet
  depositedAmount: bigint;   // cumulative amount already deposited into Vault
  secret: bigint;            // Poseidon preimage field element
  noteBalance: bigint;       // current note balance (u64), in USDC 6-decimal units
  noteNonce: bigint;         // current note nonce (u64)
  category: UserCategory;
  description: string;
}

export type UserCategory =
  | "valid_small"
  | "valid_medium"
  | "valid_large"
  | "boundary_cap"
  | "over_cap"
  | "adversarial_deposit"
  | "adversarial_zk"
  | "adversarial_address"
  | "zero_amount"
  | "max_amount"
  | "reentrancy_attacker";

const USDC = (dollars: number): bigint => BigInt(Math.round(dollars * 1_000_000));
const CAP = USDC(50_000);

// Deterministic pseudo-addresses (not real private keys — test only)
function addr(n: number): string {
  return "0x" + n.toString(16).padStart(40, "0");
}

// Deterministic secret fields (never use in production)
function secret(n: bigint): bigint {
  // Simulate a 254-bit Poseidon field element (BN254 scalar field modulus)
  const BN254_SCALAR =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  return (n * 6277101735386680763835789423207666416102355444464034512895n) % BN254_SCALAR;
}

export const VALID_USERS: MockUser[] = [
  // --- Tiny balances: $0.10 – $9.99 ---
  {
    id: "user_dust_01",
    address: addr(0x1001),
    usdcBalance: USDC(0.10),
    depositedAmount: USDC(0.10),
    secret: secret(1n),
    noteBalance: USDC(0.10),
    noteNonce: 0n,
    category: "valid_small",
    description: "Minimum $0.10 deposit — dust boundary",
  },
  {
    id: "user_dust_02",
    address: addr(0x1002),
    usdcBalance: USDC(1.0),
    depositedAmount: USDC(1.0),
    secret: secret(2n),
    noteBalance: USDC(1.0),
    noteNonce: 0n,
    category: "valid_small",
    description: "$1 depositor",
  },
  {
    id: "user_small_01",
    address: addr(0x1003),
    usdcBalance: USDC(50.0),
    depositedAmount: USDC(50.0),
    secret: secret(3n),
    noteBalance: USDC(47.50),
    noteNonce: 2n,
    category: "valid_small",
    description: "$50 depositor, 2 bets placed, $47.50 remaining",
  },
  {
    id: "user_small_02",
    address: addr(0x1004),
    usdcBalance: USDC(999.99),
    depositedAmount: USDC(999.99),
    secret: secret(4n),
    noteBalance: USDC(999.99),
    noteNonce: 0n,
    category: "valid_small",
    description: "Just under $1000",
  },

  // --- Medium balances: $1,000 – $9,999 ---
  {
    id: "user_med_01",
    address: addr(0x2001),
    usdcBalance: USDC(2_500),
    depositedAmount: USDC(2_500),
    secret: secret(10n),
    noteBalance: USDC(2_100),
    noteNonce: 4n,
    category: "valid_medium",
    description: "$2.5k depositor, 4 bets, $2.1k remaining",
  },
  {
    id: "user_med_02",
    address: addr(0x2002),
    usdcBalance: USDC(5_000),
    depositedAmount: USDC(5_000),
    secret: secret(11n),
    noteBalance: USDC(5_000),
    noteNonce: 0n,
    category: "valid_medium",
    description: "$5k depositor, no bets yet",
  },
  {
    id: "user_med_03",
    address: addr(0x2003),
    usdcBalance: USDC(9_999),
    depositedAmount: USDC(9_999),
    secret: secret(12n),
    noteBalance: USDC(8_000),
    noteNonce: 7n,
    category: "valid_medium",
    description: "$9.9k depositor, 7 bets placed",
  },

  // --- Large balances: $10,000 – $49,999 ---
  {
    id: "user_large_01",
    address: addr(0x3001),
    usdcBalance: USDC(10_000),
    depositedAmount: USDC(10_000),
    secret: secret(20n),
    noteBalance: USDC(10_000),
    noteNonce: 0n,
    category: "valid_large",
    description: "$10k depositor",
  },
  {
    id: "user_large_02",
    address: addr(0x3002),
    usdcBalance: USDC(25_000),
    depositedAmount: USDC(25_000),
    secret: secret(21n),
    noteBalance: USDC(20_000),
    noteNonce: 12n,
    category: "valid_large",
    description: "$25k depositor, 12 bets, $20k remaining",
  },
  {
    id: "user_large_03",
    address: addr(0x3003),
    usdcBalance: USDC(49_999),
    depositedAmount: USDC(49_999),
    secret: secret(22n),
    noteBalance: USDC(49_999),
    noteNonce: 0n,
    category: "valid_large",
    description: "$1 under the $50k cap",
  },
];

export const BOUNDARY_USERS: MockUser[] = [
  // --- Exactly at $50,000 cap ---
  {
    id: "user_atcap_01",
    address: addr(0x4001),
    usdcBalance: CAP,
    depositedAmount: CAP,
    secret: secret(30n),
    noteBalance: CAP,
    noteNonce: 0n,
    category: "boundary_cap",
    description: "Exactly $50k deposited — at cap limit, no further deposits allowed",
  },
  {
    id: "user_atcap_02",
    address: addr(0x4002),
    usdcBalance: CAP + USDC(50_000),
    depositedAmount: CAP,
    secret: secret(31n),
    noteBalance: USDC(40_000),
    noteNonce: 5n,
    category: "boundary_cap",
    description: "Has $100k but only $50k deposited; next deposit should revert",
  },
  // --- One wei over cap ---
  {
    id: "user_overcap_01",
    address: addr(0x4003),
    usdcBalance: CAP + 1n,
    depositedAmount: CAP,
    secret: secret(32n),
    noteBalance: USDC(49_000),
    noteNonce: 3n,
    category: "over_cap",
    description: "Cumulative at cap; any additional deposit of even 1 wei must revert",
  },
];

export const ADVERSARIAL_USERS: MockUser[] = [
  // --- Cap circumvention attempts ---
  {
    id: "adv_cap_split_01",
    address: addr(0x5001),
    usdcBalance: USDC(100_000),
    depositedAmount: USDC(25_000),
    secret: secret(40n),
    noteBalance: USDC(25_000),
    noteNonce: 0n,
    category: "adversarial_deposit",
    description: "Splits deposits across sessions to approach cap gradually",
  },
  {
    id: "adv_cap_split_02",
    address: addr(0x5001), // SAME address as above — different session
    usdcBalance: USDC(100_000),
    depositedAmount: USDC(25_001), // second deposit would push over $50k total
    secret: secret(40n),
    noteBalance: USDC(50_001),
    noteNonce: 1n,
    category: "adversarial_deposit",
    description: "Second deposit that would exceed $50k cap — must revert",
  },

  // --- ZK note manipulation attacks ---
  {
    id: "adv_zk_wrong_secret",
    address: addr(0x5002),
    usdcBalance: USDC(1_000),
    depositedAmount: USDC(1_000),
    secret: 0n,  // zero secret — weakest possible
    noteBalance: USDC(1_000),
    noteNonce: 0n,
    category: "adversarial_zk",
    description: "Attempts to use secret=0 (trivially guessable)",
  },
  {
    id: "adv_zk_wrong_balance",
    address: addr(0x5003),
    usdcBalance: USDC(500),
    depositedAmount: USDC(500),
    secret: secret(50n),
    noteBalance: USDC(99_000),  // lying about balance — higher than deposited
    noteNonce: 0n,
    category: "adversarial_zk",
    description: "Claims note balance much higher than deposited amount",
  },
  {
    id: "adv_zk_nonce_rollback",
    address: addr(0x5004),
    usdcBalance: USDC(5_000),
    depositedAmount: USDC(5_000),
    secret: secret(51n),
    noteBalance: USDC(5_000),
    noteNonce: 0n,  // tries to reuse nonce=0 after a bet has been placed
    category: "adversarial_zk",
    description: "Attempts nonce rollback — reuse committed note from nonce=0 after spending it",
  },
  {
    id: "adv_zk_replay_nullifier",
    address: addr(0x5005),
    usdcBalance: USDC(2_000),
    depositedAmount: USDC(2_000),
    secret: secret(52n),
    noteBalance: USDC(2_000),
    noteNonce: 0n,
    category: "adversarial_zk",
    description: "Attempts nullifier replay — submit same bet proof twice",
  },
  {
    id: "adv_zk_stale_root",
    address: addr(0x5006),
    usdcBalance: USDC(3_000),
    depositedAmount: USDC(3_000),
    secret: secret(53n),
    noteBalance: USDC(3_000),
    noteNonce: 0n,
    category: "adversarial_zk",
    description: "Uses a Merkle root older than the 30-root window",
  },
  {
    id: "adv_zk_wrong_commitment",
    address: addr(0x5007),
    usdcBalance: USDC(1_500),
    depositedAmount: USDC(1_500),
    secret: secret(54n),
    noteBalance: USDC(1_500),
    noteNonce: 0n,
    category: "adversarial_zk",
    description: "Produces wrong new_commitment (different balance than proved)",
  },
  {
    id: "adv_zk_overbetting",
    address: addr(0x5008),
    usdcBalance: USDC(1_000),
    depositedAmount: USDC(1_000),
    secret: secret(55n),
    noteBalance: USDC(1_000),
    noteNonce: 0n,
    category: "adversarial_zk",
    description: "Bets more than note balance — must fail balance check in circuit",
  },
  {
    id: "adv_zk_wrong_shares",
    address: addr(0x5009),
    usdcBalance: USDC(1_000),
    depositedAmount: USDC(1_000),
    secret: secret(56n),
    noteBalance: USDC(1_000),
    noteNonce: 0n,
    category: "adversarial_zk",
    description: "Wrong expected_shares for given bet_amount/price — fails Vault-injected check",
  },
  {
    id: "adv_zk_wrong_recipient",
    address: addr(0x5010),
    usdcBalance: USDC(10_000),
    depositedAmount: USDC(10_000),
    secret: secret(57n),
    noteBalance: USDC(10_000),
    noteNonce: 0n,
    category: "adversarial_zk",
    description: "Withdrawal proof commits to recipient_hash for address A, but calldata has address B",
  },
  {
    id: "adv_zk_na_abuse",
    address: addr(0x5011),
    usdcBalance: USDC(5_000),
    depositedAmount: USDC(5_000),
    secret: secret(58n),
    noteBalance: USDC(4_000),
    noteNonce: 1n,
    category: "adversarial_zk",
    description: "Claims N/A cancellation on a market that resolved YES",
  },
  {
    id: "adv_zk_double_credit",
    address: addr(0x5012),
    usdcBalance: USDC(2_000),
    depositedAmount: USDC(2_000),
    secret: secret(59n),
    noteBalance: USDC(2_000),
    noteNonce: 0n,
    category: "adversarial_zk",
    description: "Attempts creditSettlement twice for the same bet (nullifier_of_bet replay)",
  },
  {
    id: "adv_zk_status_skip",
    address: addr(0x5013),
    usdcBalance: USDC(3_000),
    depositedAmount: USDC(3_000),
    secret: secret(60n),
    noteBalance: USDC(3_000),
    noteNonce: 0n,
    category: "adversarial_zk",
    description: "Attempts betCancellationCredit on ACTIVE bet (not yet FAILED)",
  },

  // --- Address-level attacks ---
  {
    id: "adv_addr_zero",
    address: "0x0000000000000000000000000000000000000000",
    usdcBalance: 0n,
    depositedAmount: 0n,
    secret: secret(70n),
    noteBalance: 0n,
    noteNonce: 0n,
    category: "adversarial_address",
    description: "Zero address — deposit must revert (ERC-20 transferFrom to zero address)",
  },
  {
    id: "adv_addr_contract",
    address: addr(0x6001), // placeholder — in tests this is a malicious contract
    usdcBalance: USDC(10_000),
    depositedAmount: USDC(10_000),
    secret: secret(71n),
    noteBalance: USDC(10_000),
    noteNonce: 0n,
    category: "reentrancy_attacker",
    description: "Malicious contract that calls withdraw() again inside the USDC transfer callback",
  },
  {
    id: "adv_addr_operator_impersonator",
    address: addr(0x6002),
    usdcBalance: 0n,
    depositedAmount: 0n,
    secret: 0n,
    noteBalance: 0n,
    noteNonce: 0n,
    category: "adversarial_address",
    description: "Non-operator trying to call reportFOKFailure — must revert Unauthorized",
  },

  // --- Zero/max amount edge cases ---
  {
    id: "adv_zero_deposit",
    address: addr(0x7001),
    usdcBalance: USDC(100),
    depositedAmount: 0n,
    secret: secret(80n),
    noteBalance: 0n,
    noteNonce: 0n,
    category: "zero_amount",
    description: "Deposits $0 — must revert (safeTransferFrom(0) or explicit check)",
  },
  {
    id: "adv_zero_bet",
    address: addr(0x7002),
    usdcBalance: USDC(1_000),
    depositedAmount: USDC(1_000),
    secret: secret(81n),
    noteBalance: USDC(1_000),
    noteNonce: 0n,
    category: "zero_amount",
    description: "Bets $0 — circuit balance check should fail or produce invalid shares",
  },
  {
    id: "adv_zero_withdrawal",
    address: addr(0x7003),
    usdcBalance: USDC(500),
    depositedAmount: USDC(500),
    secret: secret(82n),
    noteBalance: USDC(500),
    noteNonce: 0n,
    category: "zero_amount",
    description: "Withdraws $0 — should be caught by circuit or Vault",
  },
  {
    id: "adv_max_u64_amount",
    address: addr(0x7004),
    usdcBalance: 18_446_744_073_709_551_615n,  // 2^64 - 1 raw units
    depositedAmount: 0n,
    secret: secret(83n),
    noteBalance: 0n,
    noteNonce: 0n,
    category: "max_amount",
    description: "max u64 USDC amount — overflow/underflow check in Vault deposit cap",
  },
  {
    id: "adv_max_u64_shares",
    address: addr(0x7005),
    usdcBalance: USDC(50_000),
    depositedAmount: USDC(50_000),
    secret: secret(84n),
    noteBalance: USDC(50_000),
    noteNonce: 0n,
    category: "max_amount",
    description: "Claims max u64 expected_shares — overflow in shares * payout_per_share (u128 check)",
  },
];

// All users combined
export const ALL_USERS: MockUser[] = [
  ...VALID_USERS,
  ...BOUNDARY_USERS,
  ...ADVERSARIAL_USERS,
];
