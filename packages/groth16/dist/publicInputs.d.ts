import type { BetAuthPublicInputs, BetCancelPublicInputs, BigNumberish, CancelCreditPublicInputs, SettlementCreditPublicInputs, WithdrawalPublicInputs } from "./interfaces";
export declare function toBigInt(value: BigNumberish): bigint;
export declare function assertFieldElement(value: BigNumberish, label: string): bigint;
export declare function formatBetAuthPublicInputs(inputs: BetAuthPublicInputs): bigint[];
export declare function formatSettlementCreditPublicInputs(inputs: SettlementCreditPublicInputs): bigint[];
export declare function formatWithdrawalPublicInputs(inputs: WithdrawalPublicInputs): bigint[];
export declare function formatBetCancelPublicInputs(inputs: BetCancelPublicInputs): bigint[];
export declare function formatCancelCreditPublicInputs(inputs: CancelCreditPublicInputs): bigint[];
//# sourceMappingURL=publicInputs.d.ts.map