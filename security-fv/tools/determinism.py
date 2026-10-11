#!/usr/bin/env python3
"""
Under-constraint analysis (Picus-style "uniqueness") of the PolyShield circuits.

 U1  Poseidon functional  : in every Poseidon(n) instance of the circuit, ALL internal wires and the output are
                            uniquely determined by the inputs (constraint propagation over F_p; no SMT).
                            This is the premise under which Poseidon is abstracted as a function H_n in the proofs.
 U2  Uniqueness           : with H_n abstracted, every non-input wire of the circuit is uniquely determined by the
                            circuit inputs. Wires fixed by propagation are listed; the remaining ones (bit
                            decompositions) are proved unique with z3 on two copies of the constraint system.
 U3  Unconstrained inputs : inputs that occur in no R1CS constraint at all (intentional ones are allow-listed).
usage: determinism.py <r1cs_dir> <out.json> [comma-separated circuit subset]
"""
import json, re, sys, time
import z3
import encode
from r1cs import BN254_R as P

R1CS_DIR, OUT = sys.argv[1], sys.argv[2]
ONLY = sys.argv[3].split(",") if len(sys.argv) > 3 else None
CIRCUITS_ALL = ["deposit", "bet_auth", "withdrawal", "settlement_credit", "bet_cancel", "cancel_credit",
            "position_close", "partial_credit", "consolidate"]
CIRCUITS = [c for c in CIRCUITS_ALL if ONLY is None or c in ONLY]
# inputs that are public-for-contract-binding only (documented as SEC-008 in the circuit sources)
INTENTIONALLY_FREE = {"bet_auth": {"market_id", "position_id"}, "settlement_credit": {"market_id"},
                      "cancel_credit": {"market_id"}}


def propagate(constraints, known, unknown_universe, bool_wires=frozenset()):
    """fixpoint of the rule: a constraint A*B=C with A,B known (or one of them a nonzero constant and the other
    containing exactly one unknown wire with nonzero coefficient) and C containing exactly one unknown wire (resp.
    fully known) determines that wire."""
    known = set(known)
    changed = True
    while changed:
        changed = False
        for (A, B, C) in constraints:
            def unk(lc): return [w for w in lc if w and w not in known]
            ua, ub, uc = unk(A), unk(B), unk(C)
            const_a = all(w == 0 for w in A) and A.get(0, 0) % P != 0
            const_b = all(w == 0 for w in B) and B.get(0, 0) % P != 0
            if not ua and not ub and len(uc) == 1:
                known.add(uc[0]); changed = True
            elif not ua and not ub and not uc:
                continue
            elif const_a and len(ub) == 1 and not uc and not ua:
                known.add(ub[0]); changed = True
            elif const_b and len(ua) == 1 and not uc and not ub:
                known.add(ua[0]); changed = True
            elif const_a and not ub and not ua and len(uc) == 1:
                known.add(uc[0]); changed = True
            elif bool_wires and not ua and not ub:
                # binary-decomposition rule:  sum_i 2^i * b_i = x   with every b_i boolean and unknown, x known
                # (all other terms known)  =>  every b_i is determined: two decompositions would differ by
                # sum_i 2^i (b_i - b'_i) = 0 (mod p) with |sum| < 2^n <= p, i.e. equal as integers (n <= 253).
                bits = [w for w in uc if w in bool_wires]
                if bits and len(bits) == len(uc):
                    co = sorted(abs(min(C[w], P - C[w])) for w in bits)
                    base = co[0]
                    same_sign = len({C[w] > P // 2 for w in bits}) == 1      # all +2^i or all -2^i (a true binary decomposition)
                    if same_sign and all(c == base * (1 << i) for i, c in enumerate(co)) and len(co) <= 253:
                        known.update(bits); changed = True
    return known


def lc_norm(lc):
    return {w: c % P for w, c in lc.items() if c % P}


report = {}
for circuit in CIRCUITS:
    t0 = time.time()
    M = encode.Model(f"{R1CS_DIR}/{circuit}.r1cs", f"{R1CS_DIR}/{circuit}.sym")
    R = M.R
    n_in = R.n_pub_out + R.n_pub_in + R.n_prv_in
    inputs = set(range(1, 1 + n_in))
    rep = {"circuit": circuit}

    # U1: Poseidon functional, per instance, on the ORIGINAL constraints inside the instance
    bad_pos = []
    by_inst = {pf: set() for (_, _, _, pf) in M.hashes}
    for ci, (A, B, C) in enumerate(R.constraints):
        ws = (set(A) | set(B) | set(C)) - {0}
        for (_, ins, out, pf) in M.hashes:
            if ws and all(R.names[w].startswith(pf + ".") for w in ws):
                by_inst[pf].add(ci)
    for (n, ins, out, pf) in M.hashes:
        cons = [tuple(lc_norm(lc) for lc in R.constraints[ci]) for ci in by_inst[pf]]
        wires = {w for (A, B, C) in cons for lc in (A, B, C) for w in lc if w}
        known = propagate(cons, set(ins), wires)
        if not (wires <= known and out in known):
            bad_pos.append((pf, len(wires - known)))
    rep["poseidon_instances"] = len(M.hashes)
    rep["poseidon_not_functional"] = bad_pos

    # U2: uniqueness of everything else
    known0 = set(inputs)
    # Poseidon outputs are functions of their inputs: treat as derivable once all inputs are known
    allc = [tuple(lc_norm(lc) for lc in c) for c in M.constraints]
    M._select(None)
    bw = {w for w in M.bool_wires}
    # (bool wires are in union-find representative space; the constraints are raw -> map through _find)
    bw = {w for w in range(1, R.n_wires) if M._find(w) in M.bool_wires} | set(M.bool_wires)
    wires_all = {w for (A, B, C) in allc for lc in (A, B, C) for w in lc if w}
    known = set(known0)
    while True:
        before = len(known)
        for (n, ins, out, pf) in M.hashes:
            if all(i in known for i in ins):
                known.add(out)
        known = propagate(allc, known, wires_all, bw)
        if len(known) == before:
            break
    remaining = sorted(wires_all - known - inputs)
    rep["wires_in_system"] = len(wires_all)
    rep["unique_by_propagation"] = len(known - inputs)
    rep["remaining_for_smt"] = len(remaining)
    # SMT uniqueness on the remaining wires (two copies sharing every other wire)
    uniq = True
    cex = None
    if remaining:
        # copy 1
        M1 = encode.Model(f"{R1CS_DIR}/{circuit}.r1cs", f"{R1CS_DIR}/{circuit}.sym")
        M2 = encode.Model(f"{R1CS_DIR}/{circuit}.r1cs", f"{R1CS_DIR}/{circuit}.sym")
        shared = {M1._find(w) for w in (known | inputs) if w}
        for m, suf in ((M1, ""), (M2, "__copy2")):
            m.shared, m.var_suffix = shared, suf
        M1.hash_syms(); M2.hash_syms()
        c1, c2 = M1.encode(None), M2.encode(None)
        diffs = []
        for w in remaining:
            r1, r2 = M1._find(w), M2._find(w)
            if r1 in M1.const:
                continue
            diffs.append(M1.rep_expr(w) != M2.rep_expr(w))
        s = z3.Solver(); s.set("timeout", 300_000)
        s.add(*c1, *c2, *M1.hash_axioms(), *M2.hash_axioms(), *M1.mul_axioms(), *M2.mul_axioms(),
              *M1.ranges(), *M2.ranges(), z3.Or(*diffs) if diffs else z3.BoolVal(False))
        r = s.check()
        uniq = str(r) == "unsat"
        rep["smt_uniqueness"] = str(r)
        if str(r) == "sat":
            m = s.model()
            cex = [str(d) for d in m.decls()][:10]
    rep["all_wires_unique_given_inputs"] = bool(uniq) and not bad_pos
    # U3
    occ = {w: 0 for w in inputs}
    for (A, B, C) in R.constraints:
        for lc in (A, B, C):
            for w in lc:
                if w in occ:
                    occ[w] += 1
    free = sorted(R.names[w][5:] for w, k in occ.items() if k == 0)
    allowed = INTENTIONALLY_FREE.get(circuit, set())
    rep["inputs_in_no_constraint"] = free
    rep["unexpected_free_inputs"] = [f for f in free if f not in allowed]
    rep["seconds"] = round(time.time() - t0, 1)
    report[circuit] = rep
    print(f"{circuit:18} poseidon functional: {len(M.hashes) - len(bad_pos)}/{len(M.hashes)}  "
          f"wires {rep['wires_in_system']}: {rep['unique_by_propagation']} unique by propagation, "
          f"{rep['remaining_for_smt']} via SMT ({rep.get('smt_uniqueness','-')})  "
          f"free inputs {free}  unexpected={rep['unexpected_free_inputs']}  [{rep['seconds']}s]", flush=True)
json.dump(report, open(OUT, "w"), indent=1)
bad = [c for c, r in report.items() if not r["all_wires_unique_given_inputs"] or r["unexpected_free_inputs"]]
print("PROBLEMS:", bad)
sys.exit(1 if bad else 0)
