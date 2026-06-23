# packages/circuits/pipeline — Groth16 build pipeline

Reconstructed pipeline that compiles the active Circom circuits, runs the Groth16 trusted
setup, and generates the on-chain **IVerifier-adapter** Solidity verifiers + the frontend
wasm/zkey artifacts + the `RealVerifier.t.sol` fixtures.

> Why this exists: the audit found `CLAUDE.md`, the root `package.json` `circuits:*` scripts, and
> the verifier-source comments all referenced `packages/circuits/pipeline/`, but it was missing. The
> only prior regen script (`packages/circuits/regen-verifiers.sh`) used barretenberg (`bb`) —
> the UltraHonk tooling `CLAUDE.md` forbids — and was wrong for Groth16. This pipeline replaces it.

## Prerequisites

- **Node ≥ 22.13** (so `pnpm` works) and `pnpm install` at the repo root.
- **circom 2.1.6** on `PATH` — install the Rust compiler:
  `cargo install --git https://github.com/iden3/circom --tag v2.1.6 circom` (or download a release).
- **circomlib** resolvable at `packages/circuits/node_modules` — provided by
  `packages/circuits/package.json`; `pnpm install` creates the symlink. The `.circom` files use
  relative includes (`../../node_modules/circomlib/...`).
- **A Powers-of-Tau file.** Size it to the largest circuit (check with
  `snarkjs r1cs info artifacts/bet_auth/bet_auth.r1cs`; depth-32 Poseidon circuits usually need
  2^17–2^18). Place it at `ptau/powersOfTau28_hez_final_17.ptau` or set `POT_PATH`:
  ```bash
  mkdir -p ptau
  curl -L -o ptau/powersOfTau28_hez_final_17.ptau \
    https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_17.ptau
  ```
- **Foundry** (`forge`) to run the on-chain verification tests afterward.

## Usage

```bash
cd packages/circuits/pipeline
pnpm install
pnpm compile:circuits     # circom -> artifacts/<id>/{<id>.r1cs, <id>_js/<id>.wasm}
pnpm setup:circuits       # groth16 setup + contribute -> setup/<id>.zkey (+ vkey.json)
pnpm generate:verifiers   # -> packages/contracts/src/verifiers/<Name>Verifier.sol
pnpm copy:artifacts       # wasm -> frontend/public/circuits, zkey -> frontend/public/zkeys
pnpm generate:test-proofs # -> packages/contracts/test/fixtures/{deposit,position_close,partial_credit}_proof.json
# or all at once:
pnpm all
```

From the repo root the documented aliases also work: `pnpm circuits:compile`, `pnpm circuits:setup`,
`pnpm circuits:verifiers`, `pnpm circuits:all` (extended to also copy artifacts and regenerate fixtures).

## Important notes

- **A fresh setup changes every verifying key**, so it regenerates **all 8** verifiers, **all**
  zkeys/wasm, and **all 3** RealVerifier fixtures together — including `deposit` (whose `.circom`
  is unedited but whose VK changes with a new setup). Run the whole sequence, then
  `cd packages/contracts && forge test --match-contract RealVerifierTest`.
- This is a **dev/testnet** setup. A production deployment needs a proper multi-party
  Powers-of-Tau / phase-2 ceremony.
- The generated verifier format is fixed: `<Name>G16Base` (snarkjs `Groth16Verifier`, renamed) +
  `<Name>Verifier is IVerifier` adapter decoding `abi.encode(uint256[2] pA, uint256[2][2] pB,
  uint256[2] pC)`. Do not hand-edit the verifiers — regenerate.

## After regenerating

```bash
cd ../../packages/contracts && forge build && forge test --match-contract RealVerifierTest
```
This confirms the regenerated verifiers accept the regenerated fixtures (and reject tampered inputs).
