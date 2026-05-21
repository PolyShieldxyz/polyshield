import path from "path";

import type { CircuitId } from "./interfaces";

export const BN254_SCALAR_FIELD = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617"
);

export const PACKAGE_ROOT = path.resolve(__dirname, "..");
export const CIRCUITS_DIR = path.join(PACKAGE_ROOT, "circuits");
export const ARTIFACTS_DIR = path.join(PACKAGE_ROOT, "artifacts");
export const SETUP_DIR = path.join(PACKAGE_ROOT, "setup");
export const CONTRACTS_DIR = path.join(PACKAGE_ROOT, "contracts");
export const GENERATED_CONTRACTS_DIR = path.join(CONTRACTS_DIR, "generated");

export const CIRCUIT_IDS: CircuitId[] = [
  "bet_auth",
  "settlement_credit",
  "withdrawal",
  "bet_cancel",
  "cancel_credit",
];

export const CIRCUIT_INPUT_LENGTHS: Record<CircuitId, number> = {
  bet_auth: 9,
  settlement_credit: 8,
  withdrawal: 4,
  bet_cancel: 5,
  cancel_credit: 6,
};
