#!/usr/bin/env python3
"""
Differential validation of the verification toolchain against ground truth.

For every generated valid input (real Poseidon, boundary values) and every circuit:
  D1  circom's wasm witness satisfies the exact O0 R1CS and the exact O2 (deployed-build) R1CS
      [validates the .r1cs/.wtns readers]
  D2  the O0 witness, projected by signal name onto the O2 wires, satisfies the O2 R1CS
      [evidence that --O2 only eliminates signals; containment direction]
  D3  the public-signal vector (names + values) is identical between O0 and O2 builds
  D4  union-find substitution used by the SMT encoder is consistent with the witness (merged wires are equal)
  D5  the SMT encoding of the (Poseidon-abstracted) constraint system accepts the witness, with the abstract
      hash H interpreted as the real Poseidon values observed in the witness   [no over-constraining => proofs not vacuous]
  D6  every security clause of the spec holds on the witness (spec sanity check against real Poseidon)

usage: differential.py <wasm_dir> <cases_dir> <out.json>      (wasm_dir has O0/ and O2/)
"""
import glob, json, os, subprocess, sys, struct, time
import z3

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, f"{HERE}/../tools")
import r1cs as r1cslib, encode, specs

WASM, CASES, OUT = sys.argv[1:4]
SNARKJS = f"{HERE}/../node_modules/.bin/snarkjs"
P = r1cslib.BN254_R


def read_wtns(path):
    d = open(path, "rb").read()
    assert d[:4] == b"wtns"
    nsec = struct.unpack_from("<I", d, 8)[0]
    off, secs = 12, {}
    for _ in range(nsec):
        t, sz = struct.unpack_from("<IQ", d, off); off += 12; secs[t] = (off, sz); off += sz
    o, _ = secs[1]
    n8 = struct.unpack_from("<I", d, o)[0]
    nw = struct.unpack_from("<I", d, o + 4 + n8)[0]
    o2, _ = secs[2]
    return [int.from_bytes(d[o2 + i * n8:o2 + (i + 1) * n8], "little") for i in range(nw)]


def lc_eval(lc, w):
    return sum(c * w[i] for i, c in lc.items()) % P


def r1cs_ok(R, w, only=None):
    bad = 0
    for (A, B, C) in (R.constraints if only is None else only):
        if (lc_eval(A, w) * lc_eval(B, w) - lc_eval(C, w)) % P:
            bad += 1
    return bad


def calc(level, circuit, case_file, out):
    if circuit.endswith("_live"):
        stem = circuit[:-5]
        wasm = f"{WASM}/live_{level}/{stem}_js/{stem}.wasm"
    else:
        wasm = f"{WASM}/{level}/{circuit}_js/{circuit}.wasm"
    r = subprocess.run([SNARKJS, "wtns", "calculate", wasm, case_file, out], capture_output=True, text=True)
    return r.returncode == 0, r.stderr[-300:]


models, report, fails = {}, {}, []
t0 = time.time()
for case in sorted(glob.glob(f"{CASES}/*.json")):
    circuit = os.path.basename(case).split("__")[0]
    tag = os.path.basename(case)[:-5]
    st = report.setdefault(circuit, {"cases": 0, "D1": 0, "D2": 0, "D3": 0, "D4": 0, "D5": 0, "D6": 0})
    st["cases"] += 1
    if circuit not in models:
        live = circuit.endswith("_live")
        stem = circuit[:-5] if live else circuit
        d0, d2 = (f"{WASM}/live_O0/{stem}", f"{WASM}/live_O2/{stem}") if live else (f"{WASM}/O0/{circuit}", f"{WASM}/O2/{circuit}")
        R0 = r1cslib.load(d0 + ".r1cs", d0 + ".sym")
        R2 = r1cslib.load(d2 + ".r1cs", d2 + ".sym")
        M = encode.Model(d0 + ".r1cs", d0 + ".sym"); M.hash_syms()
        cons = M.encode(None)
        clauses = [c if isinstance(c, specs.Clause) else specs.Clause(*c) for c in specs.SPECS[circuit](M)]
        models[circuit] = (R0, R2, M, cons, clauses)
    R0, R2, M, cons, clauses = models[circuit]
    tmp0, tmp2 = f"/tmp/fv_{tag}_0.wtns", f"/tmp/fv_{tag}_2.wtns"
    ok0, e0 = calc("O0", circuit, case, tmp0)
    ok2, e2 = calc("O2", circuit, case, tmp2)
    if not (ok0 and ok2):
        fails.append(f"{tag}: witness calculation failed O0={ok0} O2={ok2} {e0 or e2}"); continue
    w0, w2 = read_wtns(tmp0), read_wtns(tmp2)
    os.remove(tmp0); os.remove(tmp2)
    # D1
    if r1cs_ok(R0, w0) == 0 and r1cs_ok(R2, w2) == 0:
        st["D1"] += 1
    else:
        fails.append(f"{tag}: D1 R1CS not satisfied by wasm witness"); continue
    # D2: project O0 witness onto O2 wires by name
    n2w0 = {n: w for w, n in R0.names.items()}
    proj = [0] * R2.n_wires
    miss = 0
    for w, n in R2.names.items():
        if n in n2w0:
            proj[w] = w0[n2w0[n]]
        elif w == 0:
            proj[0] = 1
        else:
            miss += 1
    if miss == 0 and r1cs_ok(R2, proj) == 0:
        st["D2"] += 1
    else:
        fails.append(f"{tag}: D2 projection failed (unmapped={miss})")
    # D3
    npub = R0.n_pub_out + R0.n_pub_in
    if [R0.names[i] for i in range(1, 1 + npub)] == [R2.names[i] for i in range(1, 1 + npub)] and w0[1:1 + npub] == w2[1:1 + npub]:
        st["D3"] += 1
    else:
        fails.append(f"{tag}: D3 public signals differ between O0 and O2")
    # D4: union-find / constants consistent with the witness
    d4 = all(w0[M._find(w)] == w0[w] for w in range(1, R0.n_wires) if M._find(w) not in M.const) and \
         all(w0[r] == v for r, v in M.const.items())
    st["D4"] += d4
    if not d4:
        fails.append(f"{tag}: D4 substitution inconsistent with witness")
    # D5 + D6
    s = z3.Solver(); s.set("timeout", 120000)
    s.add(*[M.vars[r] == w0[r] for r in M.vars])
    s.add(*cons)
    for (n, ins, out, _) in M.hashes:
        s.add(M.H[n](*[z3.IntVal(w0[i]) for i in ins]) == w0[out])
    for (x, y) in M.mul_spec_apps:
        pass
    r = s.check()
    if str(r) == "sat":
        st["D5"] += 1
    else:
        fails.append(f"{tag}: D5 encoded constraint system rejects a valid witness ({r})")
        continue
    ok6 = True
    for c in clauses:
        s.push()
        # clause-specific slices only drop hypotheses; here we evaluate on a fully concrete witness
        s.add(*[M.mul(x, y) == x * y for (x, y) in M.mul_spec_apps])
        s.add(z3.Not(c.formula))
        rr = s.check()
        s.pop()
        if str(rr) != "unsat":
            ok6 = False
            fails.append(f"{tag}: D6 clause fails on a valid witness: {c.label} ({rr})")
    st["D6"] += ok6
    print(f"{tag:28} ok  ({time.time()-t0:.0f}s)", flush=True)

json.dump({"report": report, "failures": fails}, open(OUT, "w"), indent=1)
print(json.dumps(report, indent=1))
print("FAILURES:", len(fails))
for f in fails[:20]:
    print("  ", f)
sys.exit(1 if fails else 0)
