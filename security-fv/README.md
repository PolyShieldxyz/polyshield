# security-fv — formal verification of the PolyShield circuits and verifiers

Tooling that machine-checks the nine Groth16/Circom circuits in `packages/circuits/groth16/` and the on-chain verification layer
(`packages/contracts/src/verifiers/` + `VaultInputs.sol`). Everything is reproducible with `./run_all.sh`.

> ## ⚠️ The Polygon deployment is NOT the same as this repository
> The contracts deployed on Polygon (test configuration, single deployer key) were built from an **older revision** than `main`:
> the verification keys of all nine verifiers differ from the ones committed here, and the `bet_cancel`, `cancel_credit` and `partial_credit`
> circuits behind them are the previous `nonce − 1` variants (see `legacy-live/`). Proofs generated from this repository's circuits/zkeys are **not** accepted
> by the deployed verifiers, and `packages/contracts/chain_address.csv` no longer lists the live verifier addresses.
> **Treat the deployed addresses with caution, do not assume the deployed code equals this repository, and do not rely on the results here as a statement about the live contracts**
> (the three previous-revision circuits are verified separately, but nothing here covers the deployed bytecode beyond its verification keys).

## What it does

| layer | method | tools |
|---|---|---|
| circuit soundness | `circom --O0` R1CS → integer-level SMT encoding with Poseidon abstracted (after proving it functional); per-circuit security clauses over ℤ (no wrap-around, value conservation, exact share arithmetic, recipient/owner/deposit binding, bet↔secret binding, consolidate padding) | `tools/`, z3 |
| proof quality | non-vacuity, mutation matrix (delete a component ⇒ some clause must become violable), uniqueness / under-constraint analysis | `tools/audit_circuit.py`, `tools/determinism.py` |
| toolchain validation | real-Poseidon witnesses vs exact O0 and O2 R1CS, vs the SMT encoding, vs every clause | `witness/` |
| arithmetic core | kernel-checked Lean 4 / Mathlib lemmas: `Num2Bits`, `LessThan`, wrap-free `+`/`−`, product identity, floor-division uniqueness | `lean/` |
| verifiers | Halmos symbolic proofs (public inputs ≥ p always rejected; adapter forwards proof + signals verbatim), Foundry fuzz / real-proof / cross-layer (Poseidon, Merkle, recipient hash) tests, negative controls | `test/`, `verifiers/gen_*.py`, `crosslayer/` |
| verifier conformance | byte-conformance to the snarkjs 0.7.5 template and pipeline adapter, VK well-formedness, public-signal order/count across R1CS ↔ pipeline ↔ adapter ↔ `VaultInputs`, slot wiring, checker self-test | `verifiers/check_verifiers.py`, `verifiers/selftest_checker.py` |

Details of the encoding: `tools/encode.py` (docstring). Clause definitions: `tools/specs.py`.

## Layout

```
run_all.sh                    one-command reproduction (FAST=1 skips the mutation matrix, WITH_LEAN=1 adds the Lean stage)
tools/    r1cs.py encode.py specs.py audit_circuit.py determinism.py build_r1cs.sh report.py
witness/  gen_inputs.mjs differential.py
verifiers/ check_verifiers.py selftest_checker.py gen_symbolic_tests.py gen_mutants.py render_*.mjs
crosslayer/ gen_vectors.mjs vectors.json
test/      verifiers/*.t.sol crosslayer/*.t.sol          (some generated; generators committed)
lean/      GadgetLemmas.lean lakefile.toml README.md
legacy-live/ bet_cancel|cancel_credit|partial_credit.circom   previous revision (e66b43c)
foundry.toml requirements.txt package.json
```

## Reproduce

```bash
cd security-fv
python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt   # z3 4.12.6, halmos 0.3.3, py_ecc
npm install --ignore-scripts                                                      # circomlib 2.0.5, circomlibjs, snarkjs 0.7.5
cargo install --locked --git https://github.com/iden3/circom --tag v2.1.6 circom  # the version the pipeline pins
export CIRCOM=$(command -v circom)                                                # forge and node >= 22 must be on PATH too
./run_all.sh                                                                      # ~40 min (circuit compiles + mutation matrix dominate; FAST=1 skips the matrix)
```
The Foundry project reads the production contracts in place and needs `packages/contracts/lib` populated (`git submodule update --init --recursive`, or run `forge build` once in `packages/contracts`).

## Limits

* A proof is only as good as its **spec**: only the clauses in `tools/specs.py` are proved, they were derived from `docs/zk-design.md`, `CLAUDE.md` and the circuit comments, and a property nobody wrote down is not covered.
  Vault logic, the signing layer, the frontend and the economics are out of scope.
* The circuit-level SMT results are not proof-assistant certificates (only the gadget lemmas in `lean/` are). Trusted base: z3, Halmos, circom, `tools/encode.py`.
* Poseidon is modelled as an ideal hash; its parameters are validated differentially (circomlibjs ↔ circuit ↔ on-chain), not proved.
* The trusted setup (ptau + circuit-specific phase 2) cannot be assessed from the repository.
* The Noir files in `packages/circuits/Noir/` are not compiled and are not covered.

