import { BN254_SCALAR_FIELD } from "./constants";
import type {
  BetAuthPublicInputs,
  BetCancelPublicInputs,
  BigNumberish,
  CancelCreditPublicInputs,
  SettlementCreditPublicInputs,
  WithdrawalPublicInputs,
} from "./interfaces";

export function toBigInt(value: BigNumberish): bigint {
  return BigInt(value);
}

export function assertFieldElement(value: BigNumberish, label: string): bigint {
  const normalized = toBigInt(value);
  if (normalized < 0n || normalized >= BN254_SCALAR_FIELD) {
    throw new Error(`${label} is outside the bn254 scalar field`);
  }
  return normalized;
}

export function formatBetAuthPublicInputs(inputs: BetAuthPublicInputs): bigint[] {
  return [
    assertFieldElement(inputs.merkle_root, "merkle_root"),
    assertFieldElement(inputs.nullifier, "nullifier"),
    assertFieldElement(inputs.new_commitment, "new_commitment"),
    assertFieldElement(inputs.bet_amount, "bet_amount"),
    assertFieldElement(inputs.price, "price"),
    assertFieldElement(inputs.expected_shares, "expected_shares"),
    assertFieldElement(inputs.market_id, "market_id"),
    assertFieldElement(inputs.outcome_side, "outcome_side"),
    assertFieldElement(inputs.position_id, "position_id"),
  ];
}

export function formatSettlementCreditPublicInputs(inputs: SettlementCreditPublicInputs): bigint[] {
  return [
    assertFieldElement(inputs.merkle_root, "merkle_root"),
    assertFieldElement(inputs.nullifier, "nullifier"),
    assertFieldElement(inputs.new_commitment, "new_commitment"),
    assertFieldElement(inputs.nullifier_of_bet, "nullifier_of_bet"),
    assertFieldElement(inputs.market_id, "market_id"),
    assertFieldElement(inputs.payout_per_share, "payout_per_share"),
    assertFieldElement(inputs.shares_held, "shares_held"),
    assertFieldElement(inputs.total_credit, "total_credit"),
  ];
}

export function formatWithdrawalPublicInputs(inputs: WithdrawalPublicInputs): bigint[] {
  return [
    assertFieldElement(inputs.merkle_root, "merkle_root"),
    assertFieldElement(inputs.nullifier, "nullifier"),
    assertFieldElement(inputs.withdrawal_amount, "withdrawal_amount"),
    assertFieldElement(inputs.recipient_hash, "recipient_hash"),
  ];
}

export function formatBetCancelPublicInputs(inputs: BetCancelPublicInputs): bigint[] {
  return [
    assertFieldElement(inputs.merkle_root, "merkle_root"),
    assertFieldElement(inputs.nullifier, "nullifier"),
    assertFieldElement(inputs.new_commitment, "new_commitment"),
    assertFieldElement(inputs.nullifier_of_bet, "nullifier_of_bet"),
    assertFieldElement(inputs.bet_amount, "bet_amount"),
  ];
}

export function formatCancelCreditPublicInputs(inputs: CancelCreditPublicInputs): bigint[] {
  return [
    assertFieldElement(inputs.merkle_root, "merkle_root"),
    assertFieldElement(inputs.nullifier, "nullifier"),
    assertFieldElement(inputs.new_commitment, "new_commitment"),
    assertFieldElement(inputs.nullifier_of_bet, "nullifier_of_bet"),
    assertFieldElement(inputs.market_id, "market_id"),
    assertFieldElement(inputs.bet_amount, "bet_amount"),
  ];
}
