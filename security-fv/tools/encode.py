"""
R1CS -> SMT (z3) encoder with Poseidon abstraction.

Pipeline
  1. Load the O0 (un-simplified) R1CS + symbol table of a PolyShield circuit.
  2. Locate every circomlib `Poseidon(n)` instance (prefix P with P.pEx.sigmaF[..] wires).
     Drop all constraints that live entirely inside a Poseidon subtree; keep the link
     constraints around it. Record (inputs, out) as an application of an abstract hash H_n.
  3. Substitute away wire-equalities / constants (union-find) and detect boolean wires
     (x*(x-1)=0). Every remaining constraint is encoded over z3 Ints in [0,p):
        - linear  sum c_i x_i + c0 = 0 (mod p): interval analysis fixes the quotient k in
          sum = p*k; when the interval admits a single k the constraint is a plain integer
          equality (this is the case for every bit-recomposition and range gadget)
        - A*B = 0      : A = 0 OR B = 0    (p is prime => F_p has no zero divisors)
        - A*B = C      : if a factor is a*x+b with x boolean, case-split on x, otherwise
                         (A*B - C) mod p = 0 over Ints
  4. Hashes: H_n are uninterpreted functions with range [0,p), injective via projection
     functions, with an arity tag so an H_2 output can never equal an H_4 output. This is the
     ideal-hash (collision-resistance) model; see README "Trusted base".
"""
import re
import z3
from r1cs import BN254_R as P, load


def signed(c):
    c %= P
    return c - P if c > P // 2 else c


class Model:
    def __init__(self, r1cs_path, sym_path, drop_components=()):
        """`drop_components`: top-level component / signal names (e.g. 'feeBits') whose constraints
        are deleted -- used by mutation testing to show which constraints each clause depends on."""
        self.R = R = load(r1cs_path, sym_path)
        self.name2w = {n: w for w, n in R.names.items()}
        self.hashes = []              # (nIn, [in wires], out wire, prefix)
        self.constraints = []         # constraints that survive Poseidon abstraction
        self.drop_components = tuple(drop_components)
        self._abstract()
        self._build()

    # ---- Poseidon abstraction --------------------------------------------------------
    def _abstract(self):
        R = self.R
        prefixes = set()
        for n in R.names.values():
            m = re.match(r"(.*?)\.pEx\.sigmaF\[", n)
            if m:
                prefixes.add(m.group(1))
        for pf in sorted(prefixes):
            ins, k = [], 0
            while f"{pf}.inputs[{k}]" in self.name2w:
                ins.append(self.name2w[f"{pf}.inputs[{k}]"])
                k += 1
            self.hashes.append((k, ins, self.name2w[f"{pf}.out"], pf))
        sub = {}
        for w, n in R.names.items():
            for (_, _, _, pf) in self.hashes:
                if n.startswith(pf + "."):
                    sub[w] = pf
                    break
        bound = {w for (_, ins, out, _) in self.hashes for w in ins + [out]}
        internal = {w for w in sub if w not in bound}
        for c in R.constraints:
            ws = (set(c[0]) | set(c[1]) | set(c[2])) - {0}
            # drop a constraint iff it lives inside ONE Poseidon subtree AND touches an internal
            # wire. Constraints over boundary wires only (e.g. `hash.inputs[1] === 0`) are kept.
            if ws and all(w in sub for w in ws) and len({sub[w] for w in ws}) == 1 \
                    and any(w in internal for w in ws):
                continue
            if self.drop_components and any(
                    self._match(R.names[w], self.drop_components) for lc in c for w in lc):
                continue
            self.constraints.append(c)
        for c in self.constraints:
            for lc in c:
                for w in lc:
                    assert w not in internal, R.names[w]
        self.n_poseidon_constraints_dropped = len(R.constraints) - len(self.constraints)

    # ---- substitution of equalities --------------------------------------------------
    def _find(self, w):
        while self.parent.get(w, w) != w:
            self.parent[w] = self.parent.get(self.parent[w], self.parent[w])
            w = self.parent[w]
        return w

    def _norm(self, lc):
        """lc (dict wire->coeff) -> dict over representative wires, key 0 = constant (mod P)."""
        out = {}
        for w, c in lc.items():
            if w == 0:
                out[0] = (out.get(0, 0) + c) % P
                continue
            r = self._find(w)
            if r in self.const:
                out[0] = (out.get(0, 0) + c * self.const[r]) % P
            else:
                out[r] = (out.get(r, 0) + c) % P
        return {w: c for w, c in out.items() if c % P}

    def _build(self):
        self.parent, self.const = {}, {}
        changed = True
        while changed:
            changed = False
            for (A, B, C) in self.constraints:
                A, B, C = self._norm(A), self._norm(B), self._norm(C)
                for X, Y in ((A, B), (B, A)):
                    if all(w == 0 for w in X):
                        k = X.get(0, 0)
                        L = {}
                        for w, c in Y.items():
                            L[w] = (L.get(w, 0) + k * c) % P
                        for w, c in C.items():
                            L[w] = (L.get(w, 0) - c) % P
                        L = {w: c for w, c in L.items() if c}
                        ws = [w for w in L if w != 0]
                        if len(ws) == 1:             # c1*x + c0 = 0  -> x constant
                            x = ws[0]
                            val = (-L.get(0, 0) * pow(L[x], -1, P)) % P
                            self.const[x] = val
                            changed = True
                        elif len(ws) == 2 and L.get(0, 0) == 0 and (L[ws[0]] + L[ws[1]]) % P == 0:
                            a, b = self._find(ws[0]), self._find(ws[1])
                            if a != b:
                                self.parent[a] = b
                                changed = True
                        break
        self.norm_all = []            # (A, B, C, source wire names of the ORIGINAL constraint)
        self.contradiction = False
        for (A0, B0, C0) in self.constraints:
            A, B, C = self._norm(A0), self._norm(B0), self._norm(C0)
            if all(w == 0 for w in A) and all(w == 0 for w in B) and all(w == 0 for w in C):
                if (A.get(0, 0) * B.get(0, 0) - C.get(0, 0)) % P:
                    self.contradiction = True
                continue
            src = {self.R.names[w] for lc in (A0, B0, C0) for w in lc}
            self.norm_all.append((A, B, C, src))
        self.norm_constraints = [(A, B, C) for (A, B, C, _) in self.norm_all]
        self.vars = {}
        self.var_suffix = ""        # appended to variable names of non-shared wires (second copy for uniqueness proofs)
        self.shared = set()         # wires whose variable is shared between copies
        self._select(None)

    @staticmethod
    def _match(name, prefixes):
        for p in prefixes:
            q = "main." + p
            if name == q or name.startswith(q + ".") or name.startswith(q + "["):
                return True
        return False

    def _select(self, support):
        """Restrict the encoded system to constraints touching the `support` components
        (None = everything). Dropping hypotheses is always sound for proving implications."""
        if support is None:
            self.norm_constraints = [(A, B, C) for (A, B, C, _) in self.norm_all]
        else:
            self.norm_constraints = [(A, B, C) for (A, B, C, src) in self.norm_all
                                     if any(self._match(n, support) for n in src)]
        # boolean wires:  X*Y = 0 with X = a*x, Y = b*(x-1)   (only from the selected slice)
        self.bool_wires = set()
        for (A, B, C) in self.norm_constraints:
            if C:
                continue
            for X, Y in ((A, B), (B, A)):
                xs = [w for w in X if w]
                ys = [w for w in Y if w]
                if len(xs) == 1 and ys == xs and X.get(0, 0) == 0 and (Y[xs[0]] + Y.get(0, 0)) % P == 0:
                    self.bool_wires.add(xs[0])

    # ---- variables ------------------------------------------------------------------
    def rep_expr(self, w):
        if w == 0:
            return z3.IntVal(1)
        r = self._find(w)
        if r in self.const:
            return z3.IntVal(self.const[r])
        if r not in self.vars:
            self.vars[r] = z3.Int(self.R.names[r] + ("" if r in self.shared else self.var_suffix))
        return self.vars[r]

    def var(self, name):
        return self.rep_expr(self.name2w[name])

    # ---- hash model -------------------------------------------------------------------
    def hash_syms(self):
        I = z3.IntSort()
        self.H = {2: z3.Function("H2", I, I, I), 4: z3.Function("H4", I, I, I, I, I)}
        self.proj = {n: [z3.Function(f"H{n}_inv{i}", I, I) for i in range(n)] for n in (2, 4)}
        self.tag = z3.Function("hash_arity", I, I)
        self.mul = z3.Function("mul", I, I, I)
        self.mul_apps = []
        self.mul_spec_apps = []

    def hash_axioms(self):
        ax = []
        for (n, ins, out, _) in self.hashes:
            args = [self.rep_expr(i) for i in ins]
            res = self.rep_expr(out)
            h = self.H[n](*args)
            ax += [res == h, z3.And(h >= 0, h < P), self.tag(h) == n]
            ax += [self.proj[n][i](h) == args[i] for i in range(n)]
        return ax

    # ---- constraint encoding ---------------------------------------------------------
    def _interval(self, w):
        if w in self.bool_wires:
            return (0, 1)
        return (0, P - 1)

    def lin_zero(self, L):
        """z3 formula for  sum_{w} L[w]*w + L[0] = 0 (mod P)."""
        if not L:
            return z3.BoolVal(True)
        lo = hi = signed(L.get(0, 0))
        e = z3.IntVal(signed(L.get(0, 0)))
        for w, c in L.items():
            if w == 0:
                continue
            c = signed(c)
            a, b = self._interval(w)
            lo += min(c * a, c * b)
            hi += max(c * a, c * b)
            e = e + c * self.rep_expr(w)
        kmin, kmax = -((-lo) // P), hi // P      # ceil(lo/P), floor(hi/P)
        if kmin > kmax:
            return z3.BoolVal(False)
        if kmax - kmin <= 3:
            return z3.Or([e == P * k for k in range(kmin, kmax + 1)]) if kmax > kmin else (e == P * kmin)
        return e % P == 0

    def _lin_expr(self, L):
        e = z3.IntVal(signed(L.get(0, 0)))
        for w, c in L.items():
            if w:
                e = e + signed(c) * self.rep_expr(w)
        return e

    def encode(self, support=None):
        self._select(support)
        self.mul_apps = []
        out = []
        for x in self.bool_wires:
            v = self.rep_expr(x)
            out.append(z3.Or(v == 0, v == 1))
        if self.contradiction:
            out.append(z3.BoolVal(False))
        for (A, B, C) in self.norm_constraints:
            const_A = all(w == 0 for w in A)
            const_B = all(w == 0 for w in B)
            if const_A or const_B:
                k, Y = (A.get(0, 0), B) if const_A else (B.get(0, 0), A)
                L = {}
                for w, c in Y.items():
                    L[w] = (L.get(w, 0) + k * c) % P
                for w, c in C.items():
                    L[w] = (L.get(w, 0) - c) % P
                out.append(self.lin_zero({w: c for w, c in L.items() if c}))
                continue
            if not C:
                # A*B = 0. skip the pure bool pattern (already added)
                xs = [w for w in A if w]
                ys = [w for w in B if w]
                if len(xs) == 1 and ys == xs and xs[0] in self.bool_wires:
                    continue
                out.append(z3.Or(self.lin_zero(A), self.lin_zero(B)))
                continue
            done = False
            for X, Y in ((A, B), (B, A)):
                xs = [w for w in X if w]
                if len(xs) == 1 and xs[0] in self.bool_wires:
                    x = xs[0]
                    c1, c0 = X[x], X.get(0, 0)
                    Lone, Lzero = {}, {}
                    for w, c in Y.items():
                        Lone[w] = (Lone.get(w, 0) + (c1 + c0) * c) % P if w else (Lone.get(0, 0) + (c1 + c0) * c) % P
                        Lzero[w] = (Lzero.get(w, 0) + c0 * c) % P
                    for w, c in C.items():
                        Lone[w] = (Lone.get(w, 0) - c) % P
                        Lzero[w] = (Lzero.get(w, 0) - c) % P
                    xv = self.rep_expr(x)
                    out.append(z3.If(xv == 1, self.lin_zero({w: c for w, c in Lone.items() if c}),
                                     self.lin_zero({w: c for w, c in Lzero.items() if c})))
                    done = True
                    break
            if done:
                continue
            xs = [w for w in A if w]
            ys = [w for w in B if w]
            if len(xs) == 1 and len(ys) == 1:
                # (a1*x + a0)*(b1*y + b0) with an uninterpreted multiplication atom mul(x,y).
                # mul(x,y) is *defined* to be x*y; the solver only gets the range axiom below,
                # which the real product satisfies, so a proof for the UF is a proof for '*'.
                x, y = self.rep_expr(xs[0]), self.rep_expr(ys[0])
                m = self.mul(x, y)
                self.mul_apps.append((x, y))
                a1, a0, b1, b0 = signed(A[xs[0]]), signed(A.get(0, 0)), signed(B[ys[0]]), signed(B.get(0, 0))
                expr = a1 * b1 * m + a1 * b0 * x + a0 * b1 * y + a0 * b0 - self._lin_expr(C)
                out.append(expr % P == 0)
            else:
                out.append((self._lin_expr(A) * self._lin_expr(B) - self._lin_expr(C)) % P == 0)
        return out

    def mul_axioms(self):
        """range axiom for the multiplication atom (true for integer multiplication)."""
        ax = []
        B64 = 2 ** 64
        for (x, y) in self.mul_apps:
            m = self.mul(x, y)
            ax.append(z3.Implies(z3.And(x >= 0, x < B64, y >= 0, y < B64), z3.And(m >= 0, m <= (B64 - 1) ** 2)))
        return ax

    def ranges(self):
        # call after encode()/spec construction so that all used vars are created
        return [z3.And(v >= 0, v < P) for v in self.vars.values()]
