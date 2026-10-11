#!/usr/bin/env python3
"""
Mutation self-test of check_verifiers.py: each deliberately corrupted copy of the contracts/pipeline MUST be
flagged by the expected check. Guards against a checker that silently passes everything.
usage: selftest_checker.py <repo_root> <r1cs_dir_O0>
"""
import json, os, re, shutil, subprocess, sys, tempfile

ROOT, R1CS = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
HERE = os.path.dirname(os.path.abspath(__file__))


def run(mutate, label, expect_substr):
    tmp = tempfile.mkdtemp()
    shutil.copytree(f"{ROOT}/packages/contracts/src", f"{tmp}/packages/contracts/src")
    os.makedirs(f"{tmp}/packages/circuits/pipeline", exist_ok=True)
    shutil.copytree(f"{ROOT}/packages/circuits/pipeline/src", f"{tmp}/packages/circuits/pipeline/src")
    mutate(tmp)
    out = f"{tmp}/out.json"
    r = subprocess.run([sys.executable, f"{HERE}/check_verifiers.py", tmp, R1CS, out], capture_output=True, text=True,
                       env=dict(os.environ))
    fails = json.load(open(out))["failures"] if os.path.exists(out) else [r.stderr[-200:]]
    hit = any(expect_substr in f for f in fails)
    print(f"  {'DETECTED' if hit and r.returncode else 'MISSED  '}  {label}   -> {len(fails)} failing check(s); expected '{expect_substr}'")
    shutil.rmtree(tmp)
    return hit and r.returncode != 0


def edit(path, fn):
    def m(tmp):
        p = f"{tmp}/{path}"
        s = open(p).read(); s2 = fn(s); assert s != s2, "mutation did not apply"; open(p, "w").write(s2)
    return m

V = "packages/contracts/src/verifiers"
tests = [
    (edit(f"{V}/BetAuthVerifier.sol", lambda s: re.sub(r"(IC3x = )(\d+)", lambda m: m.group(1) + str(int(m.group(2)) + 1), s, 1)),
     "bet_auth IC3x += 1 (VK tampered / off-curve)", "bet_auth"),
    (edit("packages/contracts/src/VaultInputs.sol", lambda s: s.replace(
        "p[3] = bytes32(uint256(i.bet_amount));\n        p[4] = bytes32(uint256(i.price));",
        "p[4] = bytes32(uint256(i.bet_amount));\n        p[3] = bytes32(uint256(i.price));")),
     "VaultInputs.verifyBetAuth swaps bet_amount/price", "VaultInputs assembly order"),
    (edit("packages/contracts/src/Vault.sol", lambda s: re.sub(r"(BET_CANCEL\s*=\s*)3", r"\g<1>4", s, 1)),
     "Vault slot constant BET_CANCEL 3 -> 4", "slot constants"),
    (edit(f"{V}/WithdrawalVerifier.sol", lambda s: s.replace("uint256[5] memory sigs;", "uint256[4] memory sigs;")),
     "withdrawal adapter sigs array 5 -> 4", "withdrawal"),
    (edit(f"{V}/DepositVerifier.sol", lambda s: s.replace("iszero(lt(v, r))", "iszero(lt(v, add(r, 1)))")),
     "deposit base: field check off-by-one (accepts v == r)", "deposit"),
    (edit(f"{V}/ConsolidateVerifier.sol", lambda s: s.replace("checkField(calldataload(add(_pubSignals, 160)))", "")),
     "consolidate base: last checkField removed", "consolidate"),
    (edit(f"{V}/PartialCreditVerifier.sol", lambda s: re.sub(r"deltax1 = \d+", lambda m: "deltax1 = " + re.search(r"gammax1 = (\d+)", s).group(1), s, 1)),
     "partial_credit delta2.x1 := gamma2.x1 (partial key degeneracy)", "partial_credit"),
    (edit("packages/circuits/pipeline/src/constants.ts", lambda s: s.replace('publicSignals: 10', 'publicSignals: 9')),
     "pipeline constants say bet_auth has 9 public signals", "bet_auth"),
]
ok = all([run(m, l, e) for (m, l, e) in tests])
print("SELFTEST", "PASS: every mutation detected" if ok else "FAIL: a mutation was missed")
sys.exit(0 if ok else 1)
