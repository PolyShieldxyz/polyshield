import {
  formatBetAuthPublicInputs,
  formatBetCancelPublicInputs,
  formatCancelCreditPublicInputs,
  formatSettlementCreditPublicInputs,
  formatWithdrawalPublicInputs,
} from "../publicInputs";

describe("public input ordering", () => {
  it("formats bet auth in vault order", () => {
    expect(
      formatBetAuthPublicInputs({
        merkle_root: 1,
        nullifier: 2,
        new_commitment: 3,
        bet_amount: 4,
        price: 5,
        expected_shares: 6,
        market_id: 7,
        outcome_side: 8,
        position_id: 9,
      })
    ).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n]);
  });

  it("formats settlement credit in vault order", () => {
    expect(
      formatSettlementCreditPublicInputs({
        merkle_root: 1,
        nullifier: 2,
        new_commitment: 3,
        nullifier_of_bet: 4,
        market_id: 5,
        payout_per_share: 6,
        shares_held: 7,
        total_credit: 8,
      })
    ).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]);
  });

  it("formats withdrawal in vault order", () => {
    expect(
      formatWithdrawalPublicInputs({
        merkle_root: 1,
        nullifier: 2,
        withdrawal_amount: 3,
        recipient_hash: 4,
      })
    ).toEqual([1n, 2n, 3n, 4n]);
  });

  it("formats bet cancel in vault order", () => {
    expect(
      formatBetCancelPublicInputs({
        merkle_root: 1,
        nullifier: 2,
        new_commitment: 3,
        nullifier_of_bet: 4,
        bet_amount: 5,
      })
    ).toEqual([1n, 2n, 3n, 4n, 5n]);
  });

  it("formats cancel credit in vault order", () => {
    expect(
      formatCancelCreditPublicInputs({
        merkle_root: 1,
        nullifier: 2,
        new_commitment: 3,
        nullifier_of_bet: 4,
        market_id: 5,
        bet_amount: 6,
      })
    ).toEqual([1n, 2n, 3n, 4n, 5n, 6n]);
  });
});
