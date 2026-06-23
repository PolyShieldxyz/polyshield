import path from "path";

// This file lives at packages/circuits/pipeline/src/lib/paths.ts
export const PIPELINE_ROOT = path.resolve(__dirname, "..", ".."); // packages/circuits/pipeline
// 5 levels up: src/lib -> src -> pipeline -> circuits -> packages -> <repo root>.
export const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", ".."); // repo root

// Circuit sources (the ACTIVE Circom circuits)
export const CIRCUITS_SRC = path.join(REPO_ROOT, "packages", "circuits", "groth16");
// circomlib must resolve here for the relative includes in groth16/lib/*.circom
// (`../../node_modules/circomlib/...`). Provided via packages/circuits/package.json.
export const CIRCOMLIB_LIB = path.join(REPO_ROOT, "packages", "circuits", "node_modules");

// Pipeline working dirs
export const ARTIFACTS = path.join(PIPELINE_ROOT, "artifacts"); // r1cs + wasm
export const SETUP = path.join(PIPELINE_ROOT, "setup"); // zkeys + vkeys
export const GENERATED = path.join(PIPELINE_ROOT, "contracts", "generated"); // verifier .sol
// Powers-of-Tau (override with POT_PATH). Size to the largest circuit (see README).
export const PTAU =
  process.env.POT_PATH || path.join(PIPELINE_ROOT, "ptau", "powersOfTau28_hez_final_17.ptau");

// Consumers
export const VERIFIERS_DEST = path.join(REPO_ROOT, "packages", "contracts", "src", "verifiers");
export const FRONTEND_WASM = path.join(REPO_ROOT, "packages", "frontend", "public", "circuits");
export const FRONTEND_ZKEY = path.join(REPO_ROOT, "packages", "frontend", "public", "zkeys");
export const FIXTURES_DEST = path.join(REPO_ROOT, "packages", "contracts", "test", "fixtures");
