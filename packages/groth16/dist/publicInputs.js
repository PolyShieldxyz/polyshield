"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toBigInt = toBigInt;
exports.assertFieldElement = assertFieldElement;
exports.formatBetAuthPublicInputs = formatBetAuthPublicInputs;
exports.formatSettlementCreditPublicInputs = formatSettlementCreditPublicInputs;
exports.formatWithdrawalPublicInputs = formatWithdrawalPublicInputs;
exports.formatBetCancelPublicInputs = formatBetCancelPublicInputs;
exports.formatCancelCreditPublicInputs = formatCancelCreditPublicInputs;
const constants_1 = require("./constants");
function toBigInt(value) {
    return BigInt(value);
}
function assertFieldElement(value, label) {
    const normalized = toBigInt(value);
    if (normalized < 0n || normalized >= constants_1.BN254_SCALAR_FIELD) {
        throw new Error(`${label} is outside the bn254 scalar field`);
    }
    return normalized;
}
function formatBetAuthPublicInputs(inputs) {
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
function formatSettlementCreditPublicInputs(inputs) {
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
function formatWithdrawalPublicInputs(inputs) {
    return [
        assertFieldElement(inputs.merkle_root, "merkle_root"),
        assertFieldElement(inputs.nullifier, "nullifier"),
        assertFieldElement(inputs.withdrawal_amount, "withdrawal_amount"),
        assertFieldElement(inputs.recipient_hash, "recipient_hash"),
    ];
}
function formatBetCancelPublicInputs(inputs) {
    return [
        assertFieldElement(inputs.merkle_root, "merkle_root"),
        assertFieldElement(inputs.nullifier, "nullifier"),
        assertFieldElement(inputs.new_commitment, "new_commitment"),
        assertFieldElement(inputs.nullifier_of_bet, "nullifier_of_bet"),
        assertFieldElement(inputs.bet_amount, "bet_amount"),
    ];
}
function formatCancelCreditPublicInputs(inputs) {
    return [
        assertFieldElement(inputs.merkle_root, "merkle_root"),
        assertFieldElement(inputs.nullifier, "nullifier"),
        assertFieldElement(inputs.new_commitment, "new_commitment"),
        assertFieldElement(inputs.nullifier_of_bet, "nullifier_of_bet"),
        assertFieldElement(inputs.market_id, "market_id"),
        assertFieldElement(inputs.bet_amount, "bet_amount"),
    ];
}
//# sourceMappingURL=publicInputs.js.map