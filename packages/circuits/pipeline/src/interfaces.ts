// CircuitId union — the 9 active Groth16 circuits in packages/circuits/groth16/.
// Keep in sync with CIRCUITS in constants.ts and the verifier slots in Vault.sol.
export type CircuitId =
  | "bet_auth"
  | "withdrawal"
  | "settlement_credit"
  | "bet_cancel"
  | "cancel_credit"
  | "deposit"
  | "position_close"
  | "partial_credit"
  | "consolidate";
