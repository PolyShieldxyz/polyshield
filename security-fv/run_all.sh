#!/usr/bin/env bash
# Reproduce every formal-verification result in this folder.   FAST=1 skips the mutation matrix; OFFLINE=1 skips the
# live-chain comparison, WITH_LEAN=1 adds the Lean stage.  Needs: circom 2.1.6, node >= 22, python >= 3.10 (pip install -r requirements.txt), foundry.
set -uo pipefail
cd "$(dirname "$0")"
PY="${PY:-python3}"
RES=results; mkdir -p $RES/circuits $RES/logs build
FAILS=()
step() { local name=$1; shift; echo; echo "=== $name"; if "$@"; then echo "[ ok ] $name"; else echo "[FAIL] $name"; FAILS+=("$name"); fi; }

# run a command with output to a log file, show the tail, and PRESERVE its exit status
logged() { local log=$1 n=$2; shift 2; "$@" > "$log" 2>&1; local rc=$?; tail -n "$n" "$log" | sed 's/\x1b\[[0-9;]*m//g'; return $rc; }

HEAD_CIRCUITS="deposit bet_auth withdrawal settlement_credit bet_cancel cancel_credit position_close partial_credit consolidate"
LIVE_CIRCUITS="bet_cancel_live cancel_credit_live partial_credit_live"
MUT=""; [ -n "${FAST:-}" ] && MUT="--no-mutation"

[ -d node_modules ] || npm install --ignore-scripts --no-audit --no-fund >/dev/null
step "build: compile circuits (circom 2.1.6, O0 + O2 + deployed-version circuits)" bash tools/build_r1cs.sh

audit_all() {
  local pids=() rc=0
  for c in $HEAD_CIRCUITS; do $PY -u tools/audit_circuit.py $c build/r1cs/O0 $RES/circuits/$c.json $MUT > $RES/logs/circuit_$c.log 2>&1 & pids+=($!); done
  for c in $LIVE_CIRCUITS; do $PY -u tools/audit_circuit.py $c build/r1cs/live $RES/circuits/$c.json $MUT > $RES/logs/circuit_$c.log 2>&1 & pids+=($!); done
  for p in "${pids[@]}"; do wait $p || rc=1; done
  for c in $HEAD_CIRCUITS $LIVE_CIRCUITS; do echo "--- $c"; grep -E "PROVED|VIOLATED|UNKNOWN|non-vacuity|FAILED" $RES/logs/circuit_$c.log | cut -c1-170; done
  return $rc
}
step "circuits: prove security clauses (SMT) + non-vacuity + mutation matrix" audit_all
step "circuits: under-constraint / uniqueness analysis (HEAD)" $PY tools/determinism.py build/r1cs/O0 $RES/determinism_head.json
step "circuits: under-constraint / uniqueness analysis (deployed versions)" $PY tools/determinism.py build/r1cs/live $RES/determinism_live.json bet_cancel,cancel_credit,partial_credit
step "toolchain validation: generate real-Poseidon witness inputs" node witness/gen_inputs.mjs build/cases 12
step "toolchain validation: witnesses vs R1CS (O0,O2) vs SMT encoding vs spec" logged $RES/logs/differential.log 3 $PY -u witness/differential.py build/wasm build/cases $RES/differential.json
step "verifiers: structural conformance (snarkjs template, adapters, VKs, layout, slots)" logged $RES/logs/verifiers.log 2 $PY verifiers/check_verifiers.py .. build/r1cs/O0 $RES/verifiers.json
step "verifiers: checker self-test (8 injected defects must all be caught)" logged $RES/logs/verifier_selftest.log 10 $PY verifiers/selftest_checker.py .. build/r1cs/O0

step "solidity: generate tests + vectors" bash -c "$PY verifiers/gen_symbolic_tests.py && $PY verifiers/gen_mutants.py && node crosslayer/gen_vectors.mjs crosslayer/vectors.json"
step "solidity: forge build" logged $RES/logs/forge_build.log 1 forge build --ast
step "solidity: forge tests (real proofs, fuzz, cross-layer, negative controls)" logged $RES/logs/forge_test.log 4 forge test
step "solidity: halmos symbolic proofs (canonicality + adapter transparency, 9 verifiers)" bash -c "halmos --contract VerifierSymbolic --function check_ --solver-timeout-assertion 0 > $RES/logs/halmos_verifiers.log 2>&1; grep -E 'PASS|FAIL|result' $RES/logs/halmos_verifiers.log | sed 's/\x1b\[[0-9;]*m//g' | tail -3; ! grep -q 'FAIL\|ERROR' $RES/logs/halmos_verifiers.log"
step "solidity: halmos negative control (the broken adapter MUST be refuted)" bash -c "halmos --contract VerifierMutants --function check_ --solver-timeout-assertion 0 > $RES/logs/halmos_mutants.log 2>&1; grep -q 'FAIL.*check_mutant_rotated_adapter' $RES/logs/halmos_mutants.log"

if command -v circomspect >/dev/null; then
  step "static analysis: circomspect (informational)" bash -c "cd ../packages/circuits/groth16 && circomspect -L ../node_modules/circomlib/circuits -l INFO *.circom > ../../../security-fv/$RES/logs/circomspect.txt 2>&1; tail -1 ../../../security-fv/$RES/logs/circomspect.txt"
fi
if [ -n "${WITH_LEAN:-}" ]; then   # needs Lean 4.34.1 + Mathlib v4.34.1 (first build downloads Mathlib)
  step "lean: kernel-check arithmetic gadget lemmas" logged $RES/logs/lean.log 12 bash -c "cd lean && lake build"
fi
step "report" $PY tools/report.py
echo; if [ ${#FAILS[@]} -eq 0 ]; then echo "ALL STAGES PASSED"; else echo "FAILED STAGES:"; printf '  - %s\n' "${FAILS[@]}"; exit 1; fi
