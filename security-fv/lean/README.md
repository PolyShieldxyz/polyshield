# lean/ — kernel-checked arithmetic lemmas

`GadgetLemmas.lean` (Lean 4.34.1, Mathlib v4.34.1) proves, for an arbitrary prime `P` with the stated size bounds (BN254's scalar field satisfies all of them):

| lemma | used by |
|---|---|
| `num2bits_sound` | every `AssertBits(64)` / `Num2Bits(65)`: boolean digits ⇒ value `< 2^n` and `x.val = Σ 2^i·b_i` over ℕ (no wrap) |
| `lessThan_sound` | circomlib `LessThan(64)`: `1 − b_64 = 1 ↔ x < y` for `x,y < 2^64` — `AssertLessThan`, `AssertNotLessThan`, `bet_nonce < nonce`, `share_remainder < price`, `price > 0` |
| `sub_nowrap` | `new = current − bet − fee` (bet_auth), `fb − wa` (withdrawal): operands and result `u64` ⇒ `b + c ≤ a` and `d = a − b − c` over ℤ — the *solvency* and *conservation* clauses |
| `add_nowrap` | `bal + credit` (all credit circuits), consolidate's running sum |
| `product_identity` | bet_auth `expected_shares·price + remainder = bet·10^8` is an equation of natural numbers, not just of field elements |
| `shares_eq_floor` | `…` and `remainder < price` ⇒ `expected_shares = ⌊bet·10^8 / price⌋` |
| `nonce_succ` | `IncrementU64`: the successor nonce is `nonce + 1` |

These are the facts that turn the R1CS-level SMT proofs into statements about *integers*; the SMT proofs re-derive them for the concrete 64/65-bit instances, and Lean proves them once for all `n`.
`#print axioms` at the end of the file shows only the standard axioms (`propext`, `Classical.choice`, `Quot.sound`). Primality of the BN254 modulus is a hypothesis (`[Fact P.Prime]`), not re-proved.

```bash
cd security-fv/lean && lake build        # first run downloads Mathlib (~GBs); or: lake env lean GadgetLemmas.lean
```
