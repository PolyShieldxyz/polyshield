"""
Per-circuit audit:  (1) prove all spec clauses
                    (2) non-vacuity: R1CS + spec + a concrete pinned instance is satisfiable
                    (3) mutation matrix: delete each component's constraints, record which clauses break
usage: audit_circuit.py <circuit> <r1cs_dir> <out.json> [--no-mutation]
"""
import sys, json, re, time, z3
import encode, specs

import os
PROVE_MS = 180_000
MUT_MS = int(os.environ.get("FV_MUT_TIMEOUT_MS", "120000"))   # raise on a quiet machine to resolve timeouts

PIN = {   # concrete, realistic values pinned for the non-vacuity check
    "deposit": {"amount": 5_000_000},
    "bet_auth": {"current_balance": 10_000_000, "bet_amount": 2_000_000, "fee": 6_150, "price": 40_000_000,
                 "nonce": 3, "outcome_side": 1},
    "withdrawal": {"final_balance": 10_000_000, "withdrawal_amount": 4_000_000, "nonce": 2},
    "settlement_credit": {"balance_before_credit": 3_000_000, "total_credit": 1_500_000, "nonce": 4, "bet_nonce": 1},
    "bet_cancel": {"current_balance": 3_000_000, "bet_amount": 1_000_000, "nonce": 4, "bet_nonce": 2},
    "cancel_credit": {"current_balance": 3_000_000, "bet_amount": 1_000_000, "nonce": 4, "bet_nonce": 2},
    "position_close": {"balance_before_credit": 3_000_000, "sell_proceeds": 900_000, "nonce": 4, "bet_nonce": 2},
    "partial_credit": {"current_balance": 3_000_000, "refund_amount": 400_000, "nonce": 4, "bet_nonce": 2},
    "bet_cancel_live": {"current_balance": 3_000_000, "bet_amount": 1_000_000, "nonce": 4},
    "cancel_credit_live": {"current_balance": 3_000_000, "bet_amount": 1_000_000, "nonce": 4},
    "partial_credit_live": {"current_balance": 3_000_000, "refund_amount": 400_000, "nonce": 4},
    "consolidate": {"is_active[0]": 1, "is_active[1]": 1, "is_active[2]": 0, "is_active[3]": 0,
                    "balance[0]": 7, "balance[1]": 5, "nonce[0]": 1},
}


def stem(circuit):
    return circuit[:-len("_live")] if circuit.endswith("_live") else circuit


def mk(circuit, d, drop=()):
    M = encode.Model(f"{d}/{stem(circuit)}.r1cs", f"{d}/{stem(circuit)}.sym", drop)
    M.hash_syms()
    return M


def run_clauses(M, clauses_fn, timeout):
    clauses = [c if isinstance(c, specs.Clause) else specs.Clause(*c) for c in clauses_fn(M)]
    proven, out = {}, []
    for c in clauses:
        cons = M.encode(c.support)
        s = z3.Solver(); s.set("timeout", timeout)
        s.add(*cons, *M.hash_axioms(), *M.mul_axioms(), *M.ranges())
        for a in c.assume:
            if a in proven:
                s.add(proven[a])
        if c.assume:
            s.add([M.mul(x, y) == x * y for (x, y) in M.mul_spec_apps])
        s.add(z3.Not(c.formula))
        t = time.time(); r = s.check(); dt = time.time() - t
        st = {"unsat": "PROVED", "sat": "VIOLATED", "unknown": "UNKNOWN"}[str(r)]
        if st == "PROVED":
            proven[c.label] = c.formula
        e = {"clause": c.label, "status": st, "seconds": round(dt, 2),
             "slice": c.support if c.support is not None else "full circuit"}
        if st == "VIOLATED":
            m = s.model()
            e["counterexample_wires"] = {str(d): str(m[d]) for d in m.decls() if str(d).startswith("main.")
                                          and not any(k in str(d) for k in ("bits", "Bits", "Check", "lt."))}
        out.append(e)
    return out


def components(M):
    """top-level names (components / intermediate signals) that are not main inputs"""
    R = M.R
    n_in = R.n_pub_out + R.n_pub_in + R.n_prv_in
    inputs = {R.names[w].split(".", 1)[1] for w in range(1, 1 + n_in)}
    inputs_base = {re.split(r"[.\[]", i)[0] for i in inputs}
    names = set()
    for n in R.names.values():
        if n.startswith("main.") and n.count(".") >= 1:
            base = re.split(r"[.\[]", n[5:])[0]
            if base not in inputs_base:
                names.add(base)
    return sorted(names)


def audit(circuit, d, mutation=True, log=print):
    res = {"circuit": circuit}
    M = mk(circuit, d)
    res["r1cs_constraints"] = len(M.R.constraints)
    res["poseidon_calls"] = len(M.hashes)
    res["public_inputs"] = [M.R.names[w][5:] for w in range(1, 1 + M.R.n_pub_out + M.R.n_pub_in)]
    res["clauses"] = run_clauses(M, specs.SPECS[circuit], PROVE_MS)
    for e in res["clauses"]:
        log(f"  {e['status']:8} {e['seconds']:7.2f}s  {e['clause'][:110]}")
    # (2) non-vacuity
    cons = M.encode(None)
    s = z3.Solver(); s.set("timeout", 120_000)
    s.add(*cons, *M.hash_axioms(), *M.mul_axioms(), *M.ranges())
    pins = [M.var("main." + k) == v for k, v in PIN[circuit].items()]
    for c in (specs.Clause(*x) if not isinstance(x, specs.Clause) else x for x in specs.SPECS[circuit](M)):
        s.add(c.formula) if c.assume == () and c.support is None else None
    s.add(*pins)
    r = s.check()
    res["non_vacuity"] = str(r)
    log(f"  non-vacuity (R1CS + spec + pinned instance {PIN[circuit]}): {r}")
    if not mutation:
        return res
    # (3) mutation matrix
    comps = components(M)
    matrix = {}
    for comp in comps:
        Mm = mk(circuit, d, [comp])
        if Mm.contradiction:
            matrix[comp] = "contradiction"
            continue
        rr = run_clauses(Mm, specs.SPECS[circuit], MUT_MS)
        broken = [e["clause"] for e in rr if e["status"] == "VIOLATED"]
        unk = [e["clause"] for e in rr if e["status"] == "UNKNOWN"]
        matrix[comp] = {"breaks": broken, "unknown": unk}
        log(f"  mutate -{comp:22} breaks {len(broken)} clause(s)" + (f", {len(unk)} timeout" if unk else "")
            + ("  <- no spec clause depends on it" if not broken and not unk else ""))
    res["mutation_matrix"] = matrix
    return res


if __name__ == "__main__":
    circuit, d, out = sys.argv[1:4]
    r = audit(circuit, d, mutation="--no-mutation" not in sys.argv)
    r["z3"] = z3.get_version_string()
    json.dump(r, open(out, "w"), indent=1)
    bad = [c["clause"] for c in r["clauses"] if c["status"] != "PROVED"]
    if bad or r["non_vacuity"] != "sat":
        print("AUDIT FAILED:", bad, "non-vacuity:", r["non_vacuity"])
        sys.exit(1)
