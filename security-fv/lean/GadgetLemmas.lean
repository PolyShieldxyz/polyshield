import Mathlib

/-!
# Kernel-checked arithmetic lemmas behind the SMT proofs

Every security clause in `../tools/specs.py` is proved by z3 on the compiled R1CS.  The facts that make those proofs *sound over the
integers* are small arithmetic lemmas about the circomlib gadgets (`Num2Bits`, `LessThan`) and about wrap-free field arithmetic.
This file proves them in Lean 4 / Mathlib so that the core of the argument does not rest on an SMT solver alone.

Everything is stated for an arbitrary prime `P` (instantiate with the BN254 scalar field; only `3·2^64 < P` and primality are used —
`P ≈ 2^253.6`).  Field elements are `ZMod P`; "`.val`" is the canonical representative in `[0, P)`.
-/

open Finset

namespace PolyShield

/-- a 0/1 digit string has value `< 2^n` -/
theorem sum_bits_lt (b : ℕ → ℕ) (hb : ∀ i, b i ≤ 1) (n : ℕ) :
    ∑ i ∈ range n, 2 ^ i * b i < 2 ^ n := by
  induction n with
  | zero => simp
  | succ n ih =>
    rw [Finset.sum_range_succ, pow_succ]
    have h := Nat.mul_le_mul_left (2 ^ n) (hb n)
    linarith

/-- the top digit of an `(n+1)`-digit string is `1` iff the value is `≥ 2^n` -/
theorem top_bit_iff (b : ℕ → ℕ) (hb : ∀ i, b i ≤ 1) (n : ℕ) :
    (2 ^ n ≤ ∑ i ∈ range (n + 1), 2 ^ i * b i) ↔ b n = 1 := by
  rw [Finset.sum_range_succ]
  have hlow := sum_bits_lt b hb n
  rcases Nat.le_one_iff_eq_zero_or_eq_one.mp (hb n) with h | h
  · rw [h]; constructor
    · intro hh; omega
    · intro hh; omega
  · rw [h]; constructor
    · intro _; rfl
    · intro _; omega

/-- **Num2Bits(n) soundness** (circomlib): boolean wires `b_i` with `Σ 2^i b_i = x` in `𝔽_P`, `2^n ≤ P`
    force `x < 2^n` and the integer identity `x.val = Σ 2^i (b_i).val` (no wrap-around). -/
theorem num2bits_sound {P : ℕ} [Fact P.Prime] (n : ℕ) (hn : 2 ^ n ≤ P)
    (b : ℕ → ZMod P) (hb : ∀ i, b i * (b i - 1) = 0) (x : ZMod P)
    (hx : x = ∑ i ∈ range n, (2 : ZMod P) ^ i * b i) :
    (∀ i, (b i).val ≤ 1) ∧ x.val = ∑ i ∈ range n, 2 ^ i * (b i).val ∧ x.val < 2 ^ n := by
  have : Fact (1 < P) := ⟨(Fact.out : P.Prime).one_lt⟩
  have h01 : ∀ i, (b i).val ≤ 1 := by
    intro i
    rcases mul_eq_zero.mp (hb i) with h | h
    · rw [h]; simp
    · have h1 : b i = 1 := sub_eq_zero.mp h
      rw [h1, ZMod.val_one]
  have hS : ∑ i ∈ range n, 2 ^ i * (b i).val < 2 ^ n := sum_bits_lt (fun i => (b i).val) h01 n
  have hxS : x = ((∑ i ∈ range n, 2 ^ i * (b i).val : ℕ) : ZMod P) := by
    rw [hx]; push_cast
    refine Finset.sum_congr rfl (fun i _ => ?_)
    rw [ZMod.natCast_zmod_val]
  have hval : x.val = ∑ i ∈ range n, 2 ^ i * (b i).val := by
    rw [hxS, ZMod.val_natCast]
    exact Nat.mod_eq_of_lt (lt_of_lt_of_le hS hn)
  exact ⟨h01, hval, hval ▸ hS⟩

/-- **LessThan(n) soundness** (circomlib): for `x,y < 2^n`, decompose `z = x + 2^n − y` into `n+1` boolean digits
    (`Num2Bits(n+1)`, needs `2^(n+1) ≤ P`) and output `1 − b_n`.  The output is `1` exactly when `x < y`. -/
theorem lessThan_sound {P : ℕ} [Fact P.Prime] (n : ℕ) (hn : 2 ^ (n + 1) ≤ P)
    (x y : ZMod P) (hx : x.val < 2 ^ n) (hy : y.val < 2 ^ n)
    (b : ℕ → ZMod P) (hb : ∀ i, b i * (b i - 1) = 0)
    (hz : x + 2 ^ n - y = ∑ i ∈ range (n + 1), (2 : ZMod P) ^ i * b i) :
    (1 - b n = 1 ↔ x.val < y.val) ∧ (b n = 0 ∨ b n = 1) := by
  have : Fact (1 < P) := ⟨(Fact.out : P.Prime).one_lt⟩
  obtain ⟨h01, hval, hlt⟩ := num2bits_sound (n + 1) hn b hb _ hz
  -- the integer value of z
  have hzv : (x + 2 ^ n - y).val = x.val + 2 ^ n - y.val := by
    have hP : x.val + 2 ^ n < P := by
      have : 2 ^ (n + 1) = 2 ^ n + 2 ^ n := by ring
      omega
    have : (x + 2 ^ n - y) = ((x.val + 2 ^ n - y.val : ℕ) : ZMod P) := by
      have hle : y.val ≤ x.val + 2 ^ n := by omega
      rw [Nat.cast_sub hle]; push_cast; simp
    rw [this, ZMod.val_natCast]
    exact Nat.mod_eq_of_lt (by omega)
  have htop := top_bit_iff (fun i => (b i).val) h01 n
  rw [hzv] at hval
  have hb01 : b n = 0 ∨ b n = 1 := by
    rcases mul_eq_zero.mp (hb n) with h | h
    · exact Or.inl h
    · exact Or.inr (sub_eq_zero.mp h)
  refine ⟨?_, hb01⟩
  constructor
  · intro h
    have hb0 : b n = 0 := by
      rcases hb01 with h0 | h1
      · exact h0
      · rw [h1] at h; simp at h
    have : (b n).val ≠ 1 := by rw [hb0]; simp
    have hnot : ¬ (2 ^ n ≤ ∑ i ∈ range (n + 1), 2 ^ i * (b i).val) := fun hh => this (htop.mp hh)
    rw [← hval] at hnot
    omega
  · intro h
    have hb0 : (b n).val ≠ 1 := by
      intro h1
      have := htop.mpr h1
      rw [← hval] at this
      omega
    rcases hb01 with h0 | h1
    · rw [h0]; simp
    · exfalso; apply hb0; rw [h1, ZMod.val_one]

/-- **wrap-free subtraction** (`bet_auth`, `withdrawal`): operands and the *result* range-checked to `u64` ⇒ no underflow,
    and the result equals the integer difference. -/
theorem sub_nowrap {P : ℕ} [Fact P.Prime] (hP : 3 * 2 ^ 64 < P) (a b c d : ZMod P)
    (ha : a.val < 2 ^ 64) (hb : b.val < 2 ^ 64) (hc : c.val < 2 ^ 64) (hd : d.val < 2 ^ 64)
    (h : d = a - b - c) :
    b.val + c.val ≤ a.val ∧ d.val = a.val - b.val - c.val := by
  have : Fact (1 < P) := ⟨(Fact.out : P.Prime).one_lt⟩
  -- d + b + c = a  in the field
  have hf : ((d.val + b.val + c.val : ℕ) : ZMod P) = ((a.val : ℕ) : ZMod P) := by
    push_cast; simp [h]; ring
  have hmod : (d.val + b.val + c.val) % P = a.val % P := (ZMod.natCast_eq_natCast_iff' _ _ _).mp hf
  rw [Nat.mod_eq_of_lt (by omega), Nat.mod_eq_of_lt (by omega)] at hmod
  constructor <;> omega

/-- **wrap-free addition** (credits): `a + c` with both `u64` never wraps in the field (needs `P > 2^65`). -/
theorem add_nowrap {P : ℕ} [Fact P.Prime] (hP : 2 ^ 65 < P) (a c : ZMod P)
    (ha : a.val < 2 ^ 64) (hc : c.val < 2 ^ 64) :
    (a + c).val = a.val + c.val := by
  have : Fact (1 < P) := ⟨(Fact.out : P.Prime).one_lt⟩
  rw [ZMod.val_add]
  exact Nat.mod_eq_of_lt (by omega)

/-- **product identity** (`bet_auth`: `computed_shares = expected_shares·price`, `lhs = computed + remainder`,
    `lhs = bet·10^8`): a field equation between small `u64` quantities is an equation of natural numbers. -/
theorem product_identity {P : ℕ} [Fact P.Prime] (hP : 2 ^ 128 + 2 ^ 64 < P) (es price rem bet : ZMod P)
    (h1 : es.val < 2 ^ 64) (h2 : price.val < 2 ^ 64) (h3 : rem.val < 2 ^ 64) (h4 : bet.val < 2 ^ 64)
    (h : es * price + rem = bet * 100000000) :
    es.val * price.val + rem.val = bet.val * 100000000 := by
  have : Fact (1 < P) := ⟨(Fact.out : P.Prime).one_lt⟩
  have hf : ((es.val * price.val + rem.val : ℕ) : ZMod P) = ((bet.val * 100000000 : ℕ) : ZMod P) := by
    push_cast; simp [h]
  have hmod := (ZMod.natCast_eq_natCast_iff' _ _ _).mp hf
  have hl : es.val * price.val + rem.val < P := by
    have : es.val * price.val ≤ 2 ^ 64 * 2 ^ 64 := Nat.mul_le_mul h1.le h2.le
    have h128 : (2 : ℕ) ^ 64 * 2 ^ 64 = 2 ^ 128 := by norm_num
    omega
  have hr : bet.val * 100000000 < P := by
    have : bet.val * 100000000 ≤ 2 ^ 64 * 100000000 := Nat.mul_le_mul_right _ h4.le
    have : (2 : ℕ) ^ 64 * 100000000 ≤ 2 ^ 128 := by norm_num
    omega
  rwa [Nat.mod_eq_of_lt hl, Nat.mod_eq_of_lt hr] at hmod

/-- **share rounding is exactly floor division**: from `es·price + rem = bet·10^8`, `rem < price` we get `es = ⌊bet·10^8 / price⌋`. -/
theorem shares_eq_floor (es price rem N : ℕ) (hp : 0 < price) (hr : rem < price)
    (h : es * price + rem = N) : es = N / price := by
  rw [← h, Nat.add_comm, Nat.add_mul_div_right _ _ hp, Nat.div_eq_of_lt hr]
  simp

/-- the successor nonce (`IncrementU64`) does not wrap when its `u64` range check passes -/
theorem nonce_succ {P : ℕ} [Fact P.Prime] (hP : 2 ^ 64 + 1 < P) (n : ZMod P) (hn : n.val < 2 ^ 64) :
    (n + 1).val = n.val + 1 := by
  have : Fact (1 < P) := ⟨(Fact.out : P.Prime).one_lt⟩
  rw [ZMod.val_add, ZMod.val_one]
  exact Nat.mod_eq_of_lt (by omega)

end PolyShield

-- axioms audit: every theorem must depend only on the standard Lean axioms (propext, Classical.choice, Quot.sound)
#print axioms PolyShield.num2bits_sound
#print axioms PolyShield.lessThan_sound
#print axioms PolyShield.sub_nowrap
#print axioms PolyShield.add_nowrap
#print axioms PolyShield.product_identity
#print axioms PolyShield.shares_eq_floor
#print axioms PolyShield.nonce_succ
