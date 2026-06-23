import { CircuitId } from "./interfaces";

export interface CircuitSpec {
  /** PascalCase verifier contract base name, e.g. BetAuth -> BetAuthVerifier.sol */
  verifier: string;
  /** number of public signals (== length of the `public [...]` list in the .circom main) */
  publicSignals: number;
}

// Public-signal counts mirror the `component main {public [...]}` declarations in
// packages/circuits/groth16/*.circom. They determine the verifier's IC count and the
// adapter's `uint256[N]` signal array. The circuit constraint edits (SEC-001/002/003/008/010)
// do NOT change these counts — only the embedded VK constants change on regeneration.
export const CIRCUITS: Record<CircuitId, CircuitSpec> = {
  bet_auth: { verifier: "BetAuth", publicSignals: 10 },
  withdrawal: { verifier: "Withdrawal", publicSignals: 5 },
  settlement_credit: { verifier: "SettlementCredit", publicSignals: 6 },
  bet_cancel: { verifier: "BetCancel", publicSignals: 5 },
  cancel_credit: { verifier: "CancelCredit", publicSignals: 6 },
  deposit: { verifier: "Deposit", publicSignals: 3 },
  position_close: { verifier: "PositionClose", publicSignals: 5 },
  partial_credit: { verifier: "PartialCredit", publicSignals: 5 },
  // Consolidate K=4 notes -> 1: public [merkle_root, nullifier[0..3], new_commitment] = 6.
  consolidate: { verifier: "Consolidate", publicSignals: 6 },
};

export const CIRCUIT_IDS = Object.keys(CIRCUITS) as CircuitId[];
