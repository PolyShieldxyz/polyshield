"""
Security specifications of the nine PolyShield circuits, as z3 predicates over the R1CS wires.

Each `spec_<circuit>(M)` returns a list of (label, z3 formula) *soundness clauses*:
    R1CS(w) AND hash-axioms  ==>  clause
i.e. every accepting witness satisfies every clause. All arithmetic in clauses is over the
mathematical integers (not F_p), which is the point: it states what the field constraints
actually imply about u64 balances (no wrap-around / no value creation).
"""
import z3

U64 = 2 ** 64
PRICE_PRECISION = 10 ** 8


class Clause:
    """One security clause. `support`: restrict the R1CS hypotheses to constraints touching these
    components (sound: fewer hypotheses). `assume`: labels of earlier clauses taken as proven."""
    def __init__(self, label, formula, support=None, assume=()):
        self.label, self.formula, self.support, self.assume = label, formula, support, tuple(assume)


def u64(x):
    return z3.And(x >= 0, x < U64)


class Ctx:
    def __init__(self, M):
        self.M = M
        self.H2 = lambda a, b: M.H[2](a, b)
        self.H4 = lambda a, b, c, d: M.H[4](a, b, c, d)
        self.mul = self._mul                    # = integer multiplication; see encode.Model.mul_axioms

    def _mul(self, a, b):
        self.M.mul_spec_apps.append((a, b))
        return self.M.mul(a, b)

    def v(self, name):
        return self.M.var("main." + name)

    def vs(self, base, n):
        return [self.v(f"{base}[{i}]") for i in range(n)]

    def merkle_root(self, leaf, sib, idx):
        cur = leaf
        for s, b in zip(sib, idx):
            cur = self.H2(z3.If(b == 1, s, cur), z3.If(b == 1, cur, s))
        return cur

    def path_ok(self, idx):
        return z3.And([z3.Or(b == 0, b == 1) for b in idx])


# ---------------------------------------------------------------------------------------
def spec_deposit(M):
    c = Ctx(M); v = c.v
    return [
        ("amount in u64", u64(v("amount"))),
        ("commitment = H4(secret, amount, 0, owner_address)  [balance==amount, nonce==0, owner bound]",
         v("commitment") == c.H4(v("secret"), v("amount"), 0, v("owner_address"))),
    ]


def _spend_note(c, bal, nonce_name="nonce"):
    """Common clauses: the spent note is in the tree and its nullifier is H2(secret, nonce)."""
    v = c.v
    sib, idx = c.vs("merkle_path", 32), c.vs("merkle_path_indices", 32)
    leaf = c.H4(v("secret"), bal, v(nonce_name), v("owner_address"))
    return [
        ("path indices boolean", c.path_ok(idx)),
        ("spent note commitment H4(secret,bal,nonce,owner) is a leaf under merkle_root",
         v("merkle_root") == c.merkle_root(leaf, sib, idx)),
        ("nullifier = H2(secret, nonce)", v("nullifier") == c.H2(v("secret"), v(nonce_name))),
        ("nonce+1 does not overflow u64", v(nonce_name) + 1 < U64),
    ]


def spec_bet_auth(M):
    c = Ctx(M); v = c.v
    cb, bet, fee, price, es, rem = (v(x) for x in
        ("current_balance", "bet_amount", "fee", "price", "expected_shares", "share_remainder"))
    return _spend_note(c, cb) + [
        ("all numeric inputs u64 (outcome_side u8)",
         z3.And([u64(x) for x in (cb, v("nonce"), bet, fee, price, es, rem)] +
                [v("outcome_side") >= 0, v("outcome_side") < 256])),
        ("SOLVENCY: current_balance >= bet_amount + fee (integers, no wrap)", cb >= bet + fee),
        Clause("price > 0", price > 0, ["priceNZ", "priceBits"]),
        Clause("share_remainder < price", rem < price, ["remainderCheck", "remainderBits", "priceBits"]),
        Clause("exact integer identity expected_shares*price + remainder = bet_amount*1e8",
               c.mul(es, price) + rem == bet * PRICE_PRECISION,
               ["scaled_amount", "computed_shares", "lhs", "constants", "betAmountBits", "priceBits",
                "expectedSharesBits", "remainderBits"]),
        Clause("expected_shares = floor(bet_amount*1e8 / price)", es == (bet * PRICE_PRECISION) / price, [],
               ["all numeric inputs u64 (outcome_side u8)", "price > 0", "share_remainder < price",
                "exact integer identity expected_shares*price + remainder = bet_amount*1e8"]),
        ("CONSERVATION: new_commitment = H4(secret, cb-bet-fee, nonce+1, owner)  (balance drops by exactly bet+fee)",
         v("new_commitment") == c.H4(v("secret"), cb - bet - fee, v("nonce") + 1, v("owner_address"))),
    ]


def spec_withdrawal(M):
    c = Ctx(M); v = c.v
    fb, wa = v("final_balance"), v("withdrawal_amount")
    return _spend_note(c, fb) + [
        ("balance, nonce, amount u64", z3.And(u64(fb), u64(v("nonce")), u64(wa))),
        ("withdrawal_amount <= final_balance (integers)", wa <= fb),
        ("recipient_hash = H2(owner_address, 0)  [W-to-W: recipient bound to note owner]",
         v("recipient_hash") == c.H2(v("owner_address"), 0)),
        ("recipient_address == owner_address", v("recipient_address") == v("owner_address")),
        ("CONSERVATION: partial => new note holds exactly fb-wa; full => new_commitment = 0",
         v("new_commitment") == z3.If(wa < fb,
              c.H4(v("secret"), fb - wa, v("nonce") + 1, v("owner_address")), z3.IntVal(0))),
    ]


def _credit(M, credit_name, bal_name, extra_bet_nonce=True, label=""):
    c = Ctx(M); v = c.v
    bal, cr = v(bal_name), v(credit_name)
    out = _spend_note(c, bal) + [
        ("balance, nonce, credit u64", z3.And(u64(bal), u64(v("nonce")), u64(cr))),
        (f"CONSERVATION: balance+{credit_name} < 2^64 (no overflow) and new_commitment = H4(secret, bal+{credit_name}, nonce+1, owner)",
         z3.And(bal + cr < U64,
                v("new_commitment") == c.H4(v("secret"), bal + cr, v("nonce") + 1, v("owner_address")))),
        ("bet_nonce is u64 and bet_nonce < nonce (bet predates spent note)",
         z3.And(u64(v("bet_nonce")), v("bet_nonce") < v("nonce"))),
        ("nullifier_of_bet = H2(secret, bet_nonce)  [same secret as spent note]",
         v("nullifier_of_bet") == c.H2(v("secret"), v("bet_nonce"))),
    ]
    return out


def _credit_live(M, credit_name, bal_name):
    """Circuits as DEPLOYED on Polygon (commit e66b43c): the bet is bound to the note chain by
    nullifier_of_bet = H2(secret, nonce - 1) with nonce >= 1 (SEC-002), instead of a private bet_nonce."""
    c = Ctx(M); v = c.v
    bal, cr = v(bal_name), v(credit_name)
    return _spend_note(c, bal) + [
        ("balance, nonce, credit u64", z3.And(u64(bal), u64(v("nonce")), u64(cr))),
        (f"CONSERVATION: balance+{credit_name} < 2^64 (no overflow) and new_commitment = H4(secret, bal+{credit_name}, nonce+1, owner)",
         z3.And(bal + cr < U64,
                v("new_commitment") == c.H4(v("secret"), bal + cr, v("nonce") + 1, v("owner_address")))),
        ("nonce >= 1 (SEC-002: nonce-1 cannot wrap to p-1)", v("nonce") >= 1),
        ("nullifier_of_bet = H2(secret, nonce-1)  [bet bound to the immediately preceding note, same secret]",
         v("nullifier_of_bet") == c.H2(v("secret"), v("nonce") - 1)),
    ]


def spec_bet_cancel_live(M):     return _credit_live(M, "bet_amount", "current_balance")
def spec_cancel_credit_live(M):  return _credit_live(M, "bet_amount", "current_balance")
def spec_partial_credit_live(M): return _credit_live(M, "refund_amount", "current_balance")


def spec_settlement_credit(M): return _credit(M, "total_credit", "balance_before_credit")
def spec_bet_cancel(M):        return _credit(M, "bet_amount", "current_balance")
def spec_cancel_credit(M):     return _credit(M, "bet_amount", "current_balance")
def spec_partial_credit(M):    return _credit(M, "refund_amount", "current_balance")
def spec_position_close(M):    return _credit(M, "sell_proceeds", "balance_before_credit")


def spec_consolidate(M, K=4):
    c = Ctx(M); v = c.v
    sec, bal, non = c.vs("secret", K), c.vs("balance", K), c.vs("nonce", K)
    act, nul = c.vs("is_active", K), c.vs("nullifier", K)
    out = [("is_active boolean", z3.And([z3.Or(a == 0, a == 1) for a in act])),
           ("slot 0 is active (anchors lineage, forbids all-inactive forgery)", act[0] == 1)]
    for j in range(K):
        sib = [v(f"merkle_path[{j}][{i}]") for i in range(32)]
        idx = [v(f"merkle_path_indices[{j}][{i}]") for i in range(32)]
        leaf = c.H4(sec[j], bal[j], non[j], v("owner_address"))
        out += [
            (f"slot {j}: balance, nonce u64", z3.And(u64(bal[j]), u64(non[j]))),
            (f"slot {j}: active => note is in the tree under merkle_root",
             z3.Implies(act[j] == 1, z3.And(c.path_ok(idx), v("merkle_root") == c.merkle_root(leaf, sib, idx)))),
            (f"slot {j}: nullifier = active ? H2(secret,nonce) : 0",
             nul[j] == z3.If(act[j] == 1, c.H2(sec[j], non[j]), z3.IntVal(0))),
        ]
    total = z3.Sum([z3.If(act[j] == 1, bal[j], z3.IntVal(0)) for j in range(K)])
    out += [
        ("CONSERVATION: sum of ACTIVE balances < 2^64 (no overflow)", total < U64),
        ("slot0 nonce+1 does not overflow", non[0] + 1 < U64),
        ("CONSERVATION: new_commitment = H4(secret0, sum of active balances, nonce0+1, owner)",
         v("new_commitment") == c.H4(sec[0], total, non[0] + 1, v("owner_address"))),
    ]
    return out


SPECS = {
    "deposit": spec_deposit, "bet_auth": spec_bet_auth, "withdrawal": spec_withdrawal,
    "settlement_credit": spec_settlement_credit, "bet_cancel": spec_bet_cancel,
    "cancel_credit": spec_cancel_credit, "position_close": spec_position_close,
    "partial_credit": spec_partial_credit, "consolidate": spec_consolidate,
    # circuits as deployed on-chain (commit e66b43c); source in security-fv/legacy-live/
    "bet_cancel_live": spec_bet_cancel_live, "cancel_credit_live": spec_cancel_credit_live,
    "partial_credit_live": spec_partial_credit_live,
}
