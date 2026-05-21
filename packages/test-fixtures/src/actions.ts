/**
 * Adversarial action database for battle-testing Polyshield.
 *
 * Actions model the full attack surface:
 * - On-chain: deposit(), authorizeBet(), creditSettlement(), withdraw(),
 *   reportFOKFailure(), betCancellationCredit(), naCancellationCredit()
 * - Off-chain: signing layer, proof relay, indexer API
 *
 * Each action has an expected outcome so test harnesses can assert automatically.
 */

import type { MockUser } from "./users.js";
import type { PolymarketMarket } from "./markets.js";

// --- Action type definitions ---

export type ActionType =
  | "deposit"
  | "authorize_bet"
  | "credit_settlement"
  | "withdraw"
  | "report_fok_failure"
  | "bet_cancellation_credit"
  | "na_cancellation_credit"
  | "relay_bet"
  | "relay_withdrawal"
  | "indexer_lookup";

export type ExpectedOutcome = "success" | "revert" | "revert_with" | "silent_fail";

export type AttackVector =
  | "nullifier_replay"
  | "stale_merkle_root"
  | "wrong_commitment"
  | "over_cap_deposit"
  | "insufficient_balance"
  | "wrong_shares"
  | "wrong_recipient_hash"
  | "status_violation"
  | "operator_impersonation"
  | "na_abuse"
  | "double_credit"
  | "reentrancy"
  | "zero_amount"
  | "max_amount_overflow"
  | "cross_market_abuse"
  | "ghost_market"
  | "proof_tampering"
  | "relay_ip_leak"
  | "none";  // legitimate action

export interface Action {
  id: string;
  type: ActionType;
  actorId: string;       // user.id
  marketId?: string;     // market.condition_id (for bet/settlement actions)
  outcome: ExpectedOutcome;
  revertReason?: string; // solidity error selector name or revert message
  attackVector: AttackVector;
  description: string;
  params: Record<string, unknown>;
}

// --- Helper ---
function action(
  id: string,
  type: ActionType,
  actorId: string,
  attackVector: AttackVector,
  outcome: ExpectedOutcome,
  description: string,
  params: Record<string, unknown>,
  marketId?: string,
  revertReason?: string
): Action {
  return { id, type, actorId, marketId, outcome, revertReason, attackVector, description, params };
}

// ========================================================================
// LEGITIMATE HAPPY-PATH ACTIONS (baseline for comparison)
// ========================================================================

export const HAPPY_PATH_ACTIONS: Action[] = [
  action("hp_deposit_small", "deposit", "user_dust_01", "none", "success",
    "Minimum $0.10 deposit — must succeed and insert commitment into tree",
    { amount: "100000", commitmentHex: "0x" + "01".repeat(32) }),

  action("hp_deposit_medium", "deposit", "user_med_01", "none", "success",
    "$2,500 deposit from medium user",
    { amount: "2500000000", commitmentHex: "0x" + "02".repeat(32) }),

  action("hp_deposit_large", "deposit", "user_large_03", "none", "success",
    "$49,999 deposit — just under cap",
    { amount: "49999000000", commitmentHex: "0x" + "03".repeat(32) }),

  action("hp_authorize_bet_balanced", "authorize_bet", "user_med_01", "none", "success",
    "Bet $500 at 0.52 on balanced market — valid proof, valid root, new nullifier",
    {
      betAmount: "500000000",
      price: "52000000",          // 0.52 scaled to 1e8
      expectedShares: "961538461", // 500e6 * 1e8 / 52e6 ≈ 961538461
      merkleRootIndex: 0,          // current root
    },
    "0x" + "01".repeat(32)),

  action("hp_authorize_bet_skewed", "authorize_bet", "user_large_01", "none", "success",
    "Bet $100 at 0.05 (5% Yes) — extreme price; shares = 100e6*1e8/5e6 = 2000000000",
    {
      betAmount: "100000000",
      price: "5000000",           // 0.05 scaled to 1e8
      expectedShares: "2000000000",
      merkleRootIndex: 0,
    },
    "0x" + "02".repeat(32)),

  action("hp_credit_settlement_yes", "credit_settlement", "user_med_01", "none", "success",
    "Settle resolved YES market — payout_per_share = 1e6",
    {
      nullifierOfBet: "0x" + "aa".repeat(32),
      payoutPerShare: "1000000",
      sharesHeld: "961538461",
      totalCredit: "961538461",  // shares * 1e6 / 1e6
    },
    "0x" + "64".repeat(32)),

  action("hp_withdraw_partial", "withdraw", "user_med_01", "none", "success",
    "Withdraw $1,000 from $2,100 remaining balance",
    {
      withdrawalAmount: "1000000000",
      recipientAddressHex: "0xbeef" + "00".repeat(18),
      recipientHashHex: "0x" + "ff".repeat(32),  // poseidon2(recipient, 0)
    }),

  action("hp_fok_failure", "report_fok_failure", "user_med_02", "none", "success",
    "Signing layer operator reports FOK fill failure on illiquid market",
    {
      nullifierOfBet: "0x" + "bb".repeat(32),
      callerIsOperator: true,
    }),

  action("hp_bet_cancel_credit", "bet_cancellation_credit", "user_med_02", "none", "success",
    "Cancellation credit after FOK failure — restores balance",
    {
      nullifierOfBet: "0x" + "bb".repeat(32),
      betAmount: "500000000",
      currentBalance: "4500000000",  // post-bet balance
      newBalance: "5000000000",      // restored
    }),

  action("hp_na_cancel_credit", "na_cancellation_credit", "user_large_02", "none", "success",
    "N/A cancellation credit — market resolved with all-zero numerators",
    {
      nullifierOfBet: "0x" + "cc".repeat(32),
      betAmount: "1000000000",
      marketConditionId: "0x" + "68".repeat(32), // market 104
      allZeroNumerators: true,
    },
    "0x" + "68".repeat(32)),
];

// ========================================================================
// NULLIFIER REPLAY ATTACKS
// ========================================================================

export const NULLIFIER_REPLAY_ACTIONS: Action[] = [
  action("atk_bet_nullifier_replay", "authorize_bet", "adv_zk_replay_nullifier", "nullifier_replay",
    "revert_with", "Replay same bet proof twice — second must revert NullifierSpent",
    {
      nullifier: "0x" + "dead".repeat(16),
      betAmount: "100000000",
      price: "50000000",
      expectedShares: "200000000",
      attempt: 2,  // first attempt succeeds; this is the second
    },
    "0x" + "01".repeat(32), "NullifierSpent"),

  action("atk_withdrawal_nullifier_replay", "withdraw", "adv_zk_replay_nullifier", "nullifier_replay",
    "revert_with", "Replay same withdrawal proof twice",
    {
      nullifier: "0x" + "cafe".repeat(16),
      withdrawalAmount: "500000000",
      attempt: 2,
    },
    undefined, "NullifierSpent"),

  action("atk_settlement_nullifier_replay", "credit_settlement", "adv_zk_replay_nullifier", "nullifier_replay",
    "revert_with", "Replay same settlement credit proof twice",
    {
      nullifier: "0x" + "babe".repeat(16),
      nullifierOfBet: "0x" + "face".repeat(16),
      attempt: 2,
    },
    "0x" + "64".repeat(32), "NullifierSpent"),

  action("atk_cancel_nullifier_replay", "bet_cancellation_credit", "adv_zk_replay_nullifier", "nullifier_replay",
    "revert_with", "Replay same bet cancellation credit twice",
    {
      nullifier: "0x" + "beef".repeat(16),
      nullifierOfBet: "0x" + "d00d".repeat(8),
      attempt: 2,
    },
    undefined, "NullifierSpent"),

  action("atk_na_nullifier_replay", "na_cancellation_credit", "adv_zk_replay_nullifier", "nullifier_replay",
    "revert_with", "Replay N/A cancellation credit twice",
    {
      nullifier: "0x" + "feed".repeat(16),
      nullifierOfBet: "0x" + "c0de".repeat(8),
      attempt: 2,
    },
    "0x" + "68".repeat(32), "NullifierSpent"),
];

// ========================================================================
// STALE MERKLE ROOT ATTACKS
// ========================================================================

export const STALE_ROOT_ACTIONS: Action[] = [
  action("atk_stale_root_outside_window", "authorize_bet", "adv_zk_stale_root", "stale_merkle_root",
    "revert_with", "Uses Merkle root from 31 inserts ago (outside 30-root window)",
    {
      merkleRootIndex: 31,   // 31 deposits ago — evicted from rolling window
      betAmount: "500000000",
      price: "50000000",
      expectedShares: "1000000000",
    },
    "0x" + "01".repeat(32), "UnknownRoot"),

  action("atk_stale_root_exactly_30", "authorize_bet", "user_small_01", "none", "success",
    "Uses root exactly 30 inserts ago — MUST succeed (boundary of 30-root window)",
    {
      merkleRootIndex: 30,   // exactly at the window boundary
      betAmount: "10000000",
      price: "50000000",
      expectedShares: "20000000",
    },
    "0x" + "01".repeat(32)),

  action("atk_stale_root_31", "authorize_bet", "adv_zk_stale_root", "stale_merkle_root",
    "revert_with", "Root from exactly 31 inserts ago — one beyond window",
    {
      merkleRootIndex: 31,
      betAmount: "10000000",
      price: "50000000",
      expectedShares: "20000000",
    },
    "0x" + "01".repeat(32), "UnknownRoot"),

  action("atk_stale_root_zero", "authorize_bet", "adv_zk_stale_root", "stale_merkle_root",
    "revert_with", "Uses the initial empty Merkle root (before any deposits)",
    {
      merkleRoot: "0x" + "00".repeat(32),  // empty tree root
      betAmount: "100000000",
    },
    undefined, "UnknownRoot"),
];

// ========================================================================
// WRONG COMMITMENT ATTACKS
// ========================================================================

export const WRONG_COMMITMENT_ACTIONS: Action[] = [
  action("atk_wrong_new_commitment", "authorize_bet", "adv_zk_wrong_commitment", "wrong_commitment",
    "revert_with", "Proof has wrong new_commitment (balance differs from claimed new balance)",
    {
      // In the proof, new_commitment = poseidon3(secret, wrong_balance, nonce+1)
      // But the calldata claims a different balance — circuit constraint fails
      newCommitmentManipulated: true,
      betAmount: "100000000",
      price: "50000000",
    },
    "0x" + "01".repeat(32), "ProofVerificationFailed"),

  action("atk_commitment_not_in_tree", "authorize_bet", "adv_zk_wrong_commitment", "wrong_commitment",
    "revert_with", "old_commitment exists in proof but was never inserted into tree",
    {
      fabricatedCommitment: "0x" + "11".repeat(32),
      merklePathForged: true,
    },
    "0x" + "01".repeat(32), "ProofVerificationFailed"),

  action("atk_wrong_settlement_commitment", "credit_settlement", "adv_zk_wrong_commitment", "wrong_commitment",
    "revert_with", "Settlement proof uses wrong total_credit (balance overclaimed)",
    {
      claimedTotalCredit: "999999999999",  // much more than shares * payout_per_share
      sharesHeld: "1000000",
      payoutPerShare: "1000000",           // actual = 1e6 * 1e6 / 1e6 = 1e6
    },
    "0x" + "64".repeat(32), "ProofVerificationFailed"),
];

// ========================================================================
// DEPOSIT CAP ATTACKS
// ========================================================================

export const DEPOSIT_CAP_ACTIONS: Action[] = [
  action("atk_deposit_exactly_at_cap", "deposit", "user_atcap_01", "none", "success",
    "Deposit that brings cumulative to exactly $50k — must succeed",
    { amount: "50000000000", commitmentHex: "0x" + "04".repeat(32) }),

  action("atk_deposit_one_over_cap", "deposit", "user_atcap_01", "over_cap_deposit", "revert_with",
    "Second deposit of $1 after reaching $50k cap — must revert",
    { amount: "1000000", commitmentHex: "0x" + "05".repeat(32) },
    undefined, "DepositCapExceeded"),

  action("atk_deposit_large_over_cap", "deposit", "user_atcap_02", "over_cap_deposit", "revert_with",
    "Deposit of $50k when $50k already deposited ($100k total) — must revert",
    { amount: "50000000000", commitmentHex: "0x" + "06".repeat(32) },
    undefined, "DepositCapExceeded"),

  action("atk_deposit_zero", "deposit", "adv_zero_deposit", "zero_amount", "revert_with",
    "$0 deposit — should revert (ERC-20 transferFrom 0 or explicit amount check)",
    { amount: "0", commitmentHex: "0x" + "07".repeat(32) },
    undefined, "InvalidAmount"),

  action("atk_deposit_max_u64", "deposit", "adv_max_u64_amount", "max_amount_overflow", "revert_with",
    "Deposit of max uint64 — will overflow cap check or ERC-20 transferFrom",
    { amount: "18446744073709551615", commitmentHex: "0x" + "08".repeat(32) },
    undefined, "DepositCapExceeded"),
];

// ========================================================================
// BALANCE / SHARES ATTACKS
// ========================================================================

export const BALANCE_SHARES_ACTIONS: Action[] = [
  action("atk_overbetting", "authorize_bet", "adv_zk_overbetting", "insufficient_balance",
    "revert_with", "Bets $2,000 from a $1,000 note — balance check in circuit fails",
    {
      noteBalance: "1000000000",
      betAmount: "2000000000",  // more than balance
      price: "50000000",
    },
    "0x" + "01".repeat(32), "ProofVerificationFailed"),

  action("atk_wrong_shares_too_high", "authorize_bet", "adv_zk_wrong_shares", "wrong_shares",
    "revert_with", "Claims more shares than formula gives (expected_shares inflated)",
    {
      betAmount: "100000000",    // $100
      price: "50000000",         // 0.50
      expectedShares: "999999999999",  // should be 200000000; inflated claim
    },
    "0x" + "01".repeat(32), "ProofVerificationFailed"),

  action("atk_wrong_shares_too_low", "authorize_bet", "adv_zk_wrong_shares", "wrong_shares",
    "revert_with", "Claims fewer shares than formula gives (potential front-run protection bypass)",
    {
      betAmount: "100000000",
      price: "50000000",
      expectedShares: "1",  // should be 200000000; severely underreported
    },
    "0x" + "01".repeat(32), "ProofVerificationFailed"),

  action("atk_max_shares_overflow", "authorize_bet", "adv_max_u64_shares", "max_amount_overflow",
    "revert_with", "Claims max u64 shares — shares * payout_per_share would overflow u128",
    {
      betAmount: "50000000000",     // $50k
      price: "1000",                // 0.00001 — tiny price = enormous shares
      expectedShares: "18446744073709551615",  // max u64
    },
    "0x" + "01".repeat(32), "ProofVerificationFailed"),

  action("atk_zero_bet", "authorize_bet", "adv_zero_bet", "zero_amount",
    "revert_with", "Bets $0 — produces 0 shares; Vault or circuit should reject",
    {
      betAmount: "0",
      price: "50000000",
      expectedShares: "0",
    },
    "0x" + "01".repeat(32), "InvalidAmount"),
];

// ========================================================================
// WITHDRAWAL ATTACKS
// ========================================================================

export const WITHDRAWAL_ACTIONS: Action[] = [
  action("atk_wrong_recipient_hash", "withdraw", "adv_zk_wrong_recipient", "wrong_recipient_hash",
    "revert_with",
    "Proof commits to recipient_hash for address A, but calldata passes address B",
    {
      proofRecipientAddress: "0xAAAA" + "00".repeat(18),
      calldataRecipientAddress: "0xBBBB" + "00".repeat(18),
      withdrawalAmount: "1000000000",
    },
    undefined, "InvalidRecipient"),

  action("atk_withdrawal_over_balance", "withdraw", "user_small_01", "insufficient_balance",
    "revert_with", "Withdrawal amount exceeds note balance — circuit constraint fails",
    {
      noteBalance: "47500000",   // $47.50
      withdrawalAmount: "50000000000",  // $50k — way more than balance
    },
    undefined, "ProofVerificationFailed"),

  action("atk_withdrawal_zero", "withdraw", "adv_zero_withdrawal", "zero_amount",
    "revert_with", "Withdrawal of $0 — circuit constraint withdrawal_amount <= balance passes trivially but amount check should reject",
    {
      withdrawalAmount: "0",
      recipientAddress: "0xBEEF" + "00".repeat(18),
    },
    undefined, "InvalidAmount"),

  action("atk_withdrawal_reentrancy", "withdraw", "adv_addr_contract", "reentrancy",
    "revert_with",
    "Malicious recipient contract re-enters withdraw() during USDC transfer — ReentrancyGuard must block",
    {
      recipientIsReentrant: true,
      withdrawalAmount: "1000000000",
    },
    undefined, "ReentrancyGuardReentrantCall"),
];

// ========================================================================
// STATUS VIOLATION ATTACKS
// ========================================================================

export const STATUS_VIOLATION_ACTIONS: Action[] = [
  action("atk_credit_active_bet", "credit_settlement", "adv_zk_status_skip", "status_violation",
    "revert_with", "Tries to credit settlement on ACTIVE bet (status != FILLED)",
    {
      betStatus: "ACTIVE",
      nullifierOfBet: "0x" + "a1".repeat(32),
    },
    "0x" + "64".repeat(32), "InvalidBetStatus"),

  action("atk_cancel_active_bet", "bet_cancellation_credit", "adv_zk_status_skip", "status_violation",
    "revert_with", "Tries to cancel-credit an ACTIVE bet (status != FAILED)",
    {
      betStatus: "ACTIVE",
      nullifierOfBet: "0x" + "a2".repeat(32),
    },
    undefined, "InvalidBetStatus"),

  action("atk_double_credit_after_credited", "credit_settlement", "adv_zk_double_credit", "double_credit",
    "revert_with", "Settlement credit on already-CREDITED bet",
    {
      betStatus: "CREDITED",
      nullifierOfBet: "0x" + "a3".repeat(32),
    },
    "0x" + "64".repeat(32), "InvalidBetStatus"),

  action("atk_cancel_after_credited", "bet_cancellation_credit", "adv_zk_status_skip", "status_violation",
    "revert_with", "Tries betCancellationCredit on CREDITED bet",
    {
      betStatus: "CREDITED",
      nullifierOfBet: "0x" + "a4".repeat(32),
    },
    undefined, "InvalidBetStatus"),

  action("atk_na_cancel_on_resolved_yes", "na_cancellation_credit", "adv_zk_na_abuse", "na_abuse",
    "revert_with", "Tries N/A credit on a YES-resolved market (non-zero numerators)",
    {
      nullifierOfBet: "0x" + "a5".repeat(32),
      marketPayoutNumerators: [1_000_000, 0],  // YES resolved
    },
    "0x" + "c8".repeat(32), "NotNAMarket"),

  action("atk_na_cancel_on_no_resolved", "na_cancellation_credit", "adv_zk_na_abuse", "na_abuse",
    "revert_with", "Tries N/A credit on NO-resolved market",
    {
      nullifierOfBet: "0x" + "a6".repeat(32),
      marketPayoutNumerators: [0, 1_000_000],  // NO resolved
    },
    "0x" + "c9".repeat(32), "NotNAMarket"),

  action("atk_fok_failure_wrong_status", "report_fok_failure", "user_med_02", "status_violation",
    "revert_with", "reportFOKFailure called on a bet that's already FAILED",
    {
      nullifierOfBet: "0x" + "a7".repeat(32),
      currentStatus: "FAILED",
    },
    undefined, "InvalidBetStatus"),
];

// ========================================================================
// OPERATOR IMPERSONATION ATTACKS
// ========================================================================

export const OPERATOR_ATTACKS: Action[] = [
  action("atk_operator_impersonation_fok", "report_fok_failure", "adv_addr_operator_impersonator",
    "operator_impersonation", "revert_with",
    "Non-operator address calls reportFOKFailure — must revert Unauthorized",
    {
      callerIsOperator: false,
      nullifierOfBet: "0x" + "b1".repeat(32),
    },
    undefined, "Unauthorized"),

  action("atk_operator_impersonation_deposit_wallet", "report_fok_failure", "adv_addr_operator_impersonator",
    "operator_impersonation", "revert_with",
    "Deposit wallet address tries to call reportFOKFailure (it's also not the operator)",
    {
      callerIsDepositWallet: true,
      callerIsOperator: false,
      nullifierOfBet: "0x" + "b2".repeat(32),
    },
    undefined, "Unauthorized"),
];

// ========================================================================
// CROSS-MARKET / GHOST MARKET ATTACKS
// ========================================================================

export const CROSS_MARKET_ACTIONS: Action[] = [
  action("atk_cross_market_settlement", "credit_settlement", "user_large_01", "cross_market_abuse",
    "revert_with",
    "Bet placed on market A (condition 0x01), settlement proof claims market B (condition 0x03)",
    {
      betMarketId: "0x" + "01".repeat(32),
      settlementMarketId: "0x" + "03".repeat(32),  // different market
      nullifierOfBet: "0x" + "d1".repeat(32),
    },
    "0x" + "03".repeat(32), "MarketIdMismatch"),

  action("atk_ghost_market_bet", "authorize_bet", "user_small_01", "ghost_market",
    "revert_with",
    "Bet references a non-existent market (condition_id not in CTF) — Vault can't verify settlement",
    {
      marketId: "0x" + "dead".repeat(16),  // ghost market
      betAmount: "100000000",
    },
    "0x" + "dead".repeat(16), "ProofVerificationFailed"),

  action("atk_ghost_market_na_cancel", "na_cancellation_credit", "user_small_01", "ghost_market",
    "revert_with",
    "N/A cancel on ghost market — CTF lookup returns 0 (empty condition), not [0,0] numerators",
    {
      nullifierOfBet: "0x" + "e1".repeat(32),
      marketId: "0x" + "dead".repeat(16),
    },
    "0x" + "dead".repeat(16), "NotNAMarket"),
];

// ========================================================================
// PROOF TAMPERING ATTACKS
// ========================================================================

export const PROOF_TAMPERING_ACTIONS: Action[] = [
  action("atk_empty_proof", "authorize_bet", "adv_zk_wrong_commitment", "proof_tampering",
    "revert_with", "Empty proof bytes — verifier must reject",
    {
      proofBytes: "0x",
      betAmount: "100000000",
    },
    "0x" + "01".repeat(32), "ProofVerificationFailed"),

  action("atk_truncated_proof", "authorize_bet", "adv_zk_wrong_commitment", "proof_tampering",
    "revert_with", "Truncated proof (first 32 bytes only) — verifier must reject",
    {
      proofBytes: "0x" + "01".repeat(32),
      betAmount: "100000000",
    },
    "0x" + "01".repeat(32), "ProofVerificationFailed"),

  action("atk_all_zeros_proof", "authorize_bet", "adv_zk_wrong_commitment", "proof_tampering",
    "revert_with", "All-zero proof bytes — should fail verification",
    {
      proofBytes: "0x" + "00".repeat(2048),
      betAmount: "100000000",
    },
    "0x" + "01".repeat(32), "ProofVerificationFailed"),

  action("atk_modified_public_input", "authorize_bet", "adv_zk_wrong_commitment", "proof_tampering",
    "revert_with",
    "Valid proof but calldata has tampered public input (nullifier changed by 1 bit)",
    {
      proofIsValid: true,
      publicInputTampered: true,
      tamperedField: "nullifier",
    },
    "0x" + "01".repeat(32), "ProofVerificationFailed"),

  action("atk_swapped_verifier_inputs", "credit_settlement", "adv_zk_wrong_commitment", "proof_tampering",
    "revert_with",
    "Passes bet_auth proof to creditSettlement endpoint — wrong verifier contract",
    {
      proofType: "bet_auth",
      submittedTo: "creditSettlement",
    },
    "0x" + "64".repeat(32), "ProofVerificationFailed"),
];

// ========================================================================
// RELAY / OFF-CHAIN ATTACKS
// ========================================================================

export const RELAY_ACTIONS: Action[] = [
  action("atk_relay_no_ip_in_logs", "relay_bet", "user_small_01", "none", "success",
    "Relay submits bet — verify that no source IP appears in any log line",
    {
      checkLogFields: ["x-forwarded-for", "remoteAddress", "ip", "sourceIp"],
      expectAbsent: true,
    }),

  action("atk_relay_bet_without_chain_confirm", "relay_bet", "user_small_01", "none", "revert",
    "Relay submits to CLOB before on-chain proof is confirmed (< 1 block) — signing layer must wait",
    {
      blockConfirmations: 0,
      expectSigningLayerHolds: true,
    }),

  action("atk_relay_wrong_vault_function", "relay_withdrawal", "user_med_01", "proof_tampering",
    "revert_with",
    "Relay calls wrong Vault function (withdraw instead of authorizeBet)",
    {
      intendedFunction: "authorizeBet",
      calledFunction: "withdraw",
    },
    undefined, "ProofVerificationFailed"),

  action("atk_indexer_market_not_found", "indexer_lookup", "user_small_01", "ghost_market",
    "silent_fail",
    "Indexer lookup for market_id that hasn't settled yet — must return 404",
    {
      marketId: "0x" + "f1".repeat(32),
      expectStatus: 404,
    }),

  action("atk_indexer_sql_injection", "indexer_lookup", "adv_addr_zero", "proof_tampering",
    "silent_fail",
    "SQL injection attempt in market_id URL param — parameterized query must neutralize",
    {
      marketId: "' OR '1'='1",
      expectStatus: 400,
    }),
];

// ========================================================================
// GRIEFING / DUST ATTACKS
// ========================================================================

export const GRIEFING_ACTIONS: Action[] = [
  action("atk_grief_tree_spam", "deposit", "adv_cap_split_01", "none", "success",
    "Spams deposits of $0.10 to fill Merkle tree leaves (griefing tree capacity)",
    {
      amount: "100000",
      iterations: 1000,
      totalDeposited: "100000000",  // $100 total
      description: "Tree is depth-32 (4B leaves) so this is never a real DoS, but tests rate limiting",
    }),

  action("atk_grief_event_spam", "authorize_bet", "adv_cap_split_01", "none", "success",
    "Spam authorize_bet with minimum bets to flood BetAuthorized events and stress signing layer queue",
    {
      betAmount: "100000",  // minimum $0.10 bet
      iterations: 100,
      expectQueueBehavior: "rate_limited_by_bottleneck",
    }),
];

// ========================================================================
// FULL SEQUENCES (ordered action chains for integration testing)
// ========================================================================

export interface ActionSequence {
  id: string;
  description: string;
  attackVector: AttackVector;
  steps: Action[];
  expectedFinalState: string;
}

export const ADVERSARIAL_SEQUENCES: ActionSequence[] = [
  {
    id: "seq_nullifier_replay_full",
    description: "Full nullifier replay: deposit → bet → try to bet again with same nullifier",
    attackVector: "nullifier_replay",
    steps: [
      HAPPY_PATH_ACTIONS[0],  // deposit
      HAPPY_PATH_ACTIONS[3],  // authorize bet
      NULLIFIER_REPLAY_ACTIONS[0],  // replay same bet
    ],
    expectedFinalState: "Second bet reverts NullifierSpent; first bet is still active",
  },
  {
    id: "seq_double_credit",
    description: "Fill bet → credit settlement → attempt double credit",
    attackVector: "double_credit",
    steps: [
      HAPPY_PATH_ACTIONS[0],
      HAPPY_PATH_ACTIONS[3],
      HAPPY_PATH_ACTIONS[4],  // credit settlement
      NULLIFIER_REPLAY_ACTIONS[2],  // replay settlement
    ],
    expectedFinalState: "Second credit reverts NullifierSpent (nullifier from credit proof is spent)",
  },
  {
    id: "seq_status_skip_cancel_on_active",
    description: "Bet authorized → try cancellation without reportFOKFailure",
    attackVector: "status_violation",
    steps: [
      HAPPY_PATH_ACTIONS[0],
      HAPPY_PATH_ACTIONS[3],
      STATUS_VIOLATION_ACTIONS[1],  // cancel ACTIVE bet
    ],
    expectedFinalState: "Cancel reverts InvalidBetStatus; bet remains ACTIVE",
  },
  {
    id: "seq_fok_failure_then_cancel",
    description: "Bet → FOK failure → cancellation credit → try double cancellation",
    attackVector: "double_credit",
    steps: [
      HAPPY_PATH_ACTIONS[0],
      HAPPY_PATH_ACTIONS[3],
      HAPPY_PATH_ACTIONS[6],  // reportFOKFailure
      HAPPY_PATH_ACTIONS[7],  // betCancellationCredit
      NULLIFIER_REPLAY_ACTIONS[3],  // replay cancel
    ],
    expectedFinalState: "Double cancel reverts NullifierSpent; balance correctly restored once",
  },
  {
    id: "seq_cross_market_settlement",
    description: "Bet on market A → try to credit using market B's resolution",
    attackVector: "cross_market_abuse",
    steps: [
      HAPPY_PATH_ACTIONS[0],
      HAPPY_PATH_ACTIONS[3],
      CROSS_MARKET_ACTIONS[0],  // wrong market_id in settlement
    ],
    expectedFinalState: "Settlement reverts MarketIdMismatch; bet stays ACTIVE",
  },
  {
    id: "seq_na_abuse_on_yes_market",
    description: "Bet on YES-resolved market → try N/A cancellation credit",
    attackVector: "na_abuse",
    steps: [
      HAPPY_PATH_ACTIONS[0],
      HAPPY_PATH_ACTIONS[3],
      STATUS_VIOLATION_ACTIONS[4],  // N/A cancel on YES market
    ],
    expectedFinalState: "N/A cancel reverts NotNAMarket; payout_numerators verified on-chain",
  },
  {
    id: "seq_reentrancy_attempt",
    description: "Deposit with malicious contract address → try re-entrant withdrawal",
    attackVector: "reentrancy",
    steps: [
      HAPPY_PATH_ACTIONS[0],
      WITHDRAWAL_ACTIONS[3],  // reentrancy attack on withdrawal
    ],
    expectedFinalState: "Reentrancy reverts ReentrancyGuardReentrantCall; funds stay in vault",
  },
  {
    id: "seq_cap_circumvention",
    description: "Deposit $50k → try to deposit $1 more",
    attackVector: "over_cap_deposit",
    steps: [
      DEPOSIT_CAP_ACTIONS[0],  // exactly $50k
      DEPOSIT_CAP_ACTIONS[1],  // $1 over cap
    ],
    expectedFinalState: "Second deposit reverts DepositCapExceeded; cumulative capped at $50k",
  },
];

// All flat actions combined
export const ALL_ACTIONS: Action[] = [
  ...HAPPY_PATH_ACTIONS,
  ...NULLIFIER_REPLAY_ACTIONS,
  ...STALE_ROOT_ACTIONS,
  ...WRONG_COMMITMENT_ACTIONS,
  ...DEPOSIT_CAP_ACTIONS,
  ...BALANCE_SHARES_ACTIONS,
  ...WITHDRAWAL_ACTIONS,
  ...STATUS_VIOLATION_ACTIONS,
  ...OPERATOR_ATTACKS,
  ...CROSS_MARKET_ACTIONS,
  ...PROOF_TAMPERING_ACTIONS,
  ...RELAY_ACTIONS,
  ...GRIEFING_ACTIONS,
];

// Summary stats for reporting
export function summarize(actions: Action[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const a of actions) {
    counts[a.attackVector] = (counts[a.attackVector] ?? 0) + 1;
    counts[`outcome_${a.outcome}`] = (counts[`outcome_${a.outcome}`] ?? 0) + 1;
    counts[`type_${a.type}`] = (counts[`type_${a.type}`] ?? 0) + 1;
  }
  return counts;
}
