export type BigNumberish = bigint | number | string;
export type CircuitId = "bet_auth" | "settlement_credit" | "withdrawal" | "bet_cancel" | "cancel_credit";
export interface Groth16Proof {
    pi_a: [BigNumberish, BigNumberish, BigNumberish?];
    pi_b: [[BigNumberish, BigNumberish], [BigNumberish, BigNumberish], [BigNumberish, BigNumberish]?];
    pi_c: [BigNumberish, BigNumberish, BigNumberish?];
}
export interface Groth16Artifacts {
    circuitId: CircuitId;
    circuitPath: string;
    outputDir: string;
    r1csPath: string;
    wasmPath: string;
    symPath: string;
    zkeyPath: string;
    verificationKeyPath: string;
    generatedVerifierPath: string;
}
export interface BetAuthPublicInputs {
    merkle_root: BigNumberish;
    nullifier: BigNumberish;
    new_commitment: BigNumberish;
    bet_amount: BigNumberish;
    price: BigNumberish;
    expected_shares: BigNumberish;
    market_id: BigNumberish;
    outcome_side: BigNumberish;
    position_id: BigNumberish;
}
export interface SettlementCreditPublicInputs {
    merkle_root: BigNumberish;
    nullifier: BigNumberish;
    new_commitment: BigNumberish;
    nullifier_of_bet: BigNumberish;
    market_id: BigNumberish;
    payout_per_share: BigNumberish;
    shares_held: BigNumberish;
    total_credit: BigNumberish;
}
export interface WithdrawalPublicInputs {
    merkle_root: BigNumberish;
    nullifier: BigNumberish;
    withdrawal_amount: BigNumberish;
    recipient_hash: BigNumberish;
}
export interface BetCancelPublicInputs {
    merkle_root: BigNumberish;
    nullifier: BigNumberish;
    new_commitment: BigNumberish;
    nullifier_of_bet: BigNumberish;
    bet_amount: BigNumberish;
}
export interface CancelCreditPublicInputs {
    merkle_root: BigNumberish;
    nullifier: BigNumberish;
    new_commitment: BigNumberish;
    nullifier_of_bet: BigNumberish;
    market_id: BigNumberish;
    bet_amount: BigNumberish;
}
export interface BetAuthWitnessInput extends BetAuthPublicInputs {
    secret: BigNumberish;
    current_balance: BigNumberish;
    nonce: BigNumberish;
    merkle_path: BigNumberish[];
    merkle_path_indices: BigNumberish[];
    share_remainder: BigNumberish;
}
export interface SettlementCreditWitnessInput extends SettlementCreditPublicInputs {
    secret: BigNumberish;
    balance_before_credit: BigNumberish;
    nonce: BigNumberish;
    merkle_path: BigNumberish[];
    merkle_path_indices: BigNumberish[];
}
export interface WithdrawalWitnessInput extends WithdrawalPublicInputs {
    secret: BigNumberish;
    final_balance: BigNumberish;
    nonce: BigNumberish;
    merkle_path: BigNumberish[];
    merkle_path_indices: BigNumberish[];
    recipient_address: BigNumberish;
}
export interface BetCancelWitnessInput extends BetCancelPublicInputs {
    secret: BigNumberish;
    current_balance: BigNumberish;
    nonce: BigNumberish;
    merkle_path: BigNumberish[];
    merkle_path_indices: BigNumberish[];
}
export interface CancelCreditWitnessInput extends CancelCreditPublicInputs {
    secret: BigNumberish;
    current_balance: BigNumberish;
    nonce: BigNumberish;
    merkle_path: BigNumberish[];
    merkle_path_indices: BigNumberish[];
}
export type WitnessInputByCircuit = {
    bet_auth: BetAuthWitnessInput;
    settlement_credit: SettlementCreditWitnessInput;
    withdrawal: WithdrawalWitnessInput;
    bet_cancel: BetCancelWitnessInput;
    cancel_credit: CancelCreditWitnessInput;
};
//# sourceMappingURL=interfaces.d.ts.map