#!/usr/bin/env python3
"""
Static / structural verification of the nine on-chain Groth16 verifiers and the Vault -> verifier interface.

 V1  Generator conformance : each committed <Name>G16Base is byte-identical to what the pinned snarkjs
                             template renders for the embedded verification key (=> no hand edits / no
                             drift from the audited snarkjs verifier code).
 V2  Adapter conformance   : each adapter equals pipeline buildAdapter(name, nPublic).
 V3  VK well-formedness    : every VK point is on its curve; G2 points are in the order-r subgroup; no
                             point at infinity; IC has nPublic+1 entries; gamma != delta (phase-2 happened);
                             alpha/beta/gamma shared by all circuits (single ptau) -- reported.
 V4  Public-signal layout  : R1CS public-input order (from the compiled circom circuits) ==
                             pipeline constants == adapter array size == VaultInputs assembly order ==
                             VK IC count - 1.
 V5  Verifier-slot wiring  : Vault slot constants, call sites and deploy scripts use matching slots.

usage: check_verifiers.py <repo_root> <r1cs_dir_O0> <out.json>
"""
import json, os, re, subprocess, sys, tempfile

from py_ecc.bn128 import (FQ, FQ2, b, b2, is_on_curve, multiply, curve_order, G2, field_modulus)

ROOT, R1CS_DIR, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
HERE = os.path.dirname(os.path.abspath(__file__))
CONTRACTS = f"{ROOT}/packages/contracts/src"
PIPE = f"{ROOT}/packages/circuits/pipeline/src"
SNARKJS_PREFIX = os.environ.get("SNARKJS_PREFIX", f"{HERE}/..")   # dir containing node_modules/snarkjs

CIRCUITS = {  # circuit -> (Verifier name, VaultInputs fn, slot constant)
    "bet_auth": ("BetAuth", "verifyBetAuth", "BET_AUTH"),
    "settlement_credit": ("SettlementCredit", "verifySettlement", "SETTLEMENT_CREDIT"),
    "withdrawal": ("Withdrawal", "verifyWithdrawal", "WITHDRAWAL"),
    "bet_cancel": ("BetCancel", "verifyBetCancel", "BET_CANCEL"),
    "cancel_credit": ("CancelCredit", "verifyNACancel", "CANCEL_CREDIT"),
    "deposit": ("Deposit", "verifyDeposit", "DEPOSIT"),
    "position_close": ("PositionClose", "verifyClose", "POSITION_CLOSE"),
    "partial_credit": ("PartialCredit", "verifyPartialCredit", "PARTIAL_CREDIT"),
    "consolidate": ("Consolidate", "verifyConsolidate", "CONSOLIDATE"),
}
EXPECTED_SLOT = {"BET_AUTH": 0, "SETTLEMENT_CREDIT": 1, "WITHDRAWAL": 2, "BET_CANCEL": 3, "CANCEL_CREDIT": 4,
                 "DEPOSIT": 5, "POSITION_CLOSE": 6, "PARTIAL_CREDIT": 7, "CONSOLIDATE": 8}

results, failures = {}, []


def check(cond, circuit, name, detail=""):
    results.setdefault(circuit, []).append({"check": name, "ok": bool(cond), "detail": detail})
    if not cond:
        failures.append(f"{circuit}: {name} {detail}")
    print(f"  {'PASS' if cond else 'FAIL'}  {circuit:18} {name} {detail}")


def read(p):
    return open(p).read()


# ---------------------------------------------------------------- parse VKs out of the committed verifiers
def parse_vk(src):
    c = {m.group(1): int(m.group(2)) for m in re.finditer(r"uint256 constant (\w+)\s*=\s*(\d+);", src)}
    n_ic = 0
    while f"IC{n_ic}x" in c:
        n_ic += 1
    vk = {
        "vk_alpha_1": [str(c["alphax"]), str(c["alphay"]), "1"],
        # snarkjs template: x1 = coeff[1] (imag), x2 = coeff[0] (real)
        "vk_beta_2": [[str(c["betax2"]), str(c["betax1"])], [str(c["betay2"]), str(c["betay1"])], ["1", "0"]],
        "vk_gamma_2": [[str(c["gammax2"]), str(c["gammax1"])], [str(c["gammay2"]), str(c["gammay1"])], ["1", "0"]],
        "vk_delta_2": [[str(c["deltax2"]), str(c["deltax1"])], [str(c["deltay2"]), str(c["deltay1"])], ["1", "0"]],
        "IC": [[str(c[f"IC{i}x"]), str(c[f"IC{i}y"]), "1"] for i in range(n_ic)],
        "nPublic": n_ic - 1,
    }
    return vk, n_ic


def g1(p):
    return (FQ(int(p[0])), FQ(int(p[1])))


def g2(p):
    return (FQ2([int(p[0][0]), int(p[0][1])]), FQ2([int(p[1][0]), int(p[1][1])]))


pipe_consts = {m.group(1): (m.group(2), int(m.group(3))) for m in re.finditer(
    r"(\w+):\s*\{\s*verifier:\s*\"(\w+)\",\s*publicSignals:\s*(\d+)\s*\}", read(f"{PIPE}/constants.ts"))}

# R1CS public order (compile with: circom --r1cs --sym)
sys.path.insert(0, f"{HERE}/../tools")
import r1cs as r1cslib


def circuit_public_order(circuit):
    R = r1cslib.load(f"{R1CS_DIR}/{circuit}.r1cs", f"{R1CS_DIR}/{circuit}.sym")
    return [R.names[w][len("main."):] for w in range(1, 1 + R.n_pub_out + R.n_pub_in)]


# ---------------------------------------------------------------- VaultInputs assembly order
vi = read(f"{CONTRACTS}/VaultInputs.sol")
ALIAS = {"owner": "owner_address"}


def norm_expr(e):
    e = e.strip()
    while True:
        m = re.fullmatch(r"(?:bytes32|uint256|uint160|uint64)\((.*)\)", e)
        if not m:
            break
        e = m.group(1)
    e = re.sub(r"^i\.", "", e)
    return ALIAS.get(e, e)


def vaultinputs_layout(fn):
    m = re.search(r"function %s\(.*?\n    \}" % fn, vi, re.S)
    body = m.group(0)
    n = int(re.search(r"new bytes32\[\]\((\d+)\)", body).group(1))
    elems = {int(k): norm_expr(v) for k, v in re.findall(r"p\[(\d+)\]\s*=\s*([^;]+);", body)}
    return n, [elems[k] for k in sorted(elems)]


def render_vk(vk):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(vk, f)
    env = dict(os.environ, SNARKJS_PREFIX=SNARKJS_PREFIX)
    out = subprocess.run(["node", f"{HERE}/render_snarkjs_template.mjs", f.name], capture_output=True, text=True,
                         env=env, cwd=SNARKJS_PREFIX)
    if out.returncode:
        raise SystemExit("template render failed: " + out.stderr)
    return out.stdout


def render_adapter(name, n):
    out = subprocess.run(["node", f"{HERE}/render_adapter.mjs", f"{PIPE}/lib/adapter.ts", name, str(n)],
                         capture_output=True, text=True)
    if out.returncode:
        raise SystemExit("adapter render failed: " + out.stderr)
    return out.stdout


all_vks = {}
print("== Verifier checks")
for circuit, (name, fn, slot) in CIRCUITS.items():
    src = read(f"{CONTRACTS}/verifiers/{name}Verifier.sol")
    vk, n_ic = parse_vk(src)
    all_vks[circuit] = vk
    n_pub = n_ic - 1

    # V1: generator conformance
    raw = render_vk(vk)
    base = raw[raw.index("contract Groth16Verifier"):].replace("Groth16Verifier", f"{name}G16Base")
    committed_base = src[src.index(f"contract {name}G16Base"):src.index(f"/// @notice UUPS-upgradeable IVerifier adapter")]
    check(base.strip() == committed_base.strip(), circuit, "V1 base == snarkjs-0.7.5 template(VK)")

    # V2: adapter conformance + header
    committed_adapter = src[src.index("/// @notice UUPS-upgradeable IVerifier adapter"):]
    expected_adapter = render_adapter(name, n_pub)
    check(committed_adapter.strip() == expected_adapter.strip(), circuit, "V2 adapter == pipeline buildAdapter()")

    # V3: VK well-formedness
    ok_g1 = is_on_curve(g1(vk["vk_alpha_1"]), b) and all(is_on_curve(g1(p), b) for p in vk["IC"])
    check(ok_g1, circuit, "V3 alpha1 and all IC points on G1 curve", f"(IC count {n_ic})")
    pts2 = {k: g2(vk[k]) for k in ("vk_beta_2", "vk_gamma_2", "vk_delta_2")}
    check(all(is_on_curve(p, b2) for p in pts2.values()), circuit, "V3 beta2/gamma2/delta2 on twist curve")
    check(all(multiply(p, curve_order) is None for p in pts2.values()), circuit, "V3 beta2/gamma2/delta2 in order-r subgroup")
    ic_pts = [tuple(p[:2]) for p in vk["IC"]]
    check(len(set(ic_pts)) == len(ic_pts) and all(p != ("0", "0") for p in ic_pts), circuit,
          "V3 IC points distinct and non-infinity")
    check(vk["vk_gamma_2"] != vk["vk_delta_2"], circuit, "V3 delta2 != gamma2 (a phase-2 contribution exists)")

    # V4: layout
    order = circuit_public_order(circuit)
    pn, pc = pipe_consts[circuit]
    n_vi, vi_order = vaultinputs_layout(fn)
    check(pn == name and pc == n_pub == len(order) == n_vi, circuit,
          "V4 counts agree: pipeline constants / IC-1 / R1CS publics / VaultInputs array",
          f"({pc}, {n_pub}, {len(order)}, {n_vi})")
    check(order == vi_order, circuit, "V4 VaultInputs assembly order == circuit public-input order",
          "" if order == vi_order else f"\n      circuit   : {order}\n      VaultInputs: {vi_order}")
    check(f"uint[{n_pub}] calldata _pubSignals" in src and src.count("checkField(") - 1 == n_pub, circuit,
          "V4 base verifier checkField()s every public signal (canonical form)")

# V3b: cross-circuit provenance (single ptau)
for part in ("vk_alpha_1", "vk_beta_2", "vk_gamma_2"):
    same = len({json.dumps(v[part]) for v in all_vks.values()}) == 1
    check(same, "all", f"V3 {part} identical across circuits (shared ptau / snarkjs gamma)")
check(len({json.dumps(v["vk_delta_2"]) for v in all_vks.values()}) == len(all_vks), "all",
      "V3 delta2 distinct per circuit (independent phase-2)")
G2_gen = (str(G2[0].coeffs[0]), str(G2[0].coeffs[1]), str(G2[1].coeffs[0]), str(G2[1].coeffs[1]))
vg = all_vks["bet_auth"]["vk_gamma_2"]
check((vg[0][0], vg[0][1], vg[1][0], vg[1][1]) == G2_gen, "all", "V3 gamma2 == BN254 G2 generator (snarkjs convention)")

# ---------------------------------------------------------------- V5 slot wiring
vault = read(f"{CONTRACTS}/Vault.sol")
slots = {m.group(1): int(m.group(2)) for m in re.finditer(r"uint8\s+(?:public\s+)?constant\s+(\w+)\s*=\s*(\d+);", vault)
         if m.group(1) in EXPECTED_SLOT}
check(slots == EXPECTED_SLOT, "all", "V5 Vault slot constants match documented slots", str(slots))
# every VaultLogic entry point must be handed the matching verifier slot by its Vault wrapper
WRAP = {"creditSettlement": "SETTLEMENT_CREDIT", "betCancellationCredit": "BET_CANCEL", "naCancellationCredit": "CANCEL_CREDIT",
        "closePosition": "POSITION_CLOSE", "partialFillCredit": "PARTIAL_CREDIT", "consolidate": "CONSOLIDATE"}
for fn, slot in WRAP.items():
    m = re.search(r"VaultLogic\.%s\((.*?)\);" % fn, vault, re.S)
    got = re.findall(r"verifiers\[(\w+)\]", m.group(1)) if m else []
    check(got == [slot], "all", f"V5 Vault.{fn} -> verifiers[{slot}]", str(got))
for fn, slot, call in (("deposit", "DEPOSIT", "verifyDeposit"), ("authorizeBet", "BET_AUTH", "verifyBetAuth"),
                       ("withdraw", "WITHDRAWAL", "verifyWithdrawal")):
    m = re.search(r"VaultInputs\.%s\(\s*verifiers\[(\w+)\]" % call, vault)
    check(m and m.group(1) == slot, "all", f"V5 Vault.{fn} verifies against verifiers[{slot}]", str(m.group(1) if m else None))

json.dump({"results": results, "failures": failures}, open(OUT, "w"), indent=1)
print(f"\n{sum(len(v) for v in results.values())} checks, {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
