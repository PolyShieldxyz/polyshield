# packages/circuits

This directory contains two sets of ZK circuits for Polyshield. Only the Groth16 set is active in the current build.

```
packages/circuits/
  groth16/   ← ACTIVE: Circom/Groth16 circuits compiled & proven in production
  Noir/      ← REFERENCE ONLY: Noir (.nr) spec circuits — not compiled, not wired into any build
  README.md
  package.json
```

> **All Noir circuits live under `Noir/`.** They are a specification reference only — see
> [Reference only: Noir / UltraPLONK (`Noir/`)](#reference-only-noir--ultraplonk-noir) below.

---

## Active: Groth16 / Circom (`groth16/`)

**These are the circuits used in production.** Compiled with `circom 2.1.6`, proven with `snarkjs` (Groth16 on BN254), verified on-chain by the nine adapter verifier contracts in `packages/contracts/src/verifiers/` (one per circuit, verifier slots 0–8).

```
groth16/
  bet_auth.circom          — (slot 0) Bet authorization: balance check, nullifier, new commitment, bet_amount + fee
  settlement_credit.circom — (slot 1) Winning position settlement credit
  withdrawal.circom        — (slot 2) Withdrawal to depositing address only (W-to-W)
  bet_cancel.circom        — (slot 3) Restore balance for a failed/cancelled bet
  cancel_credit.circom     — (slot 4) N/A market resolution credit (all CTF numerators zero)
  deposit.circom           — (slot 5) Mandatory deposit binding (FC-2): commitment ↔ amount + owner
  position_close.circom    — (slot 6) Pre-settlement secondary-sale credit (FC-1)
  partial_credit.circom    — (slot 7) Refund of the unfilled remainder of a partial limit fill (FC-4)
  consolidate.circom       — (slot 8) Merge up to 4 same-owner notes into 1 (FC-8)
  lib/
    note.circom            — NoteCommitment (Poseidon4), NullifierHash (Poseidon2), RecipientHash
    merkle.circom          — Poseidon Merkle path verifier (depth 32)
    checks.circom          — RangeCheck64, IncrementU64 helpers
    constants.circom       — MERKLE_DEPTH = 32
```

### Note structure (all circuits)

```
commitment = Poseidon4(secret, balance, nonce, owner_address)
nullifier  = Poseidon2(secret, nonce)
```

### Public inputs per circuit

| Circuit | Public inputs |
|---|---|
| `bet_auth` | `merkle_root, nullifier, new_commitment, bet_amount, price, expected_shares, market_id, outcome_side, position_id, fee` (10; `fee` Vault-injected, FC-10) |
| `settlement_credit` | `merkle_root, nullifier, new_commitment, nullifier_of_bet, market_id, total_credit` |
| `withdrawal` | `merkle_root, nullifier, withdrawal_amount, recipient_hash, new_commitment` |
| `bet_cancel` | `merkle_root, nullifier, new_commitment, nullifier_of_bet, bet_amount` |
| `cancel_credit` | `merkle_root, nullifier, new_commitment, nullifier_of_bet, market_id, bet_amount` |
| `deposit` | `commitment, amount, owner_address` |
| `position_close` | `merkle_root, nullifier, new_commitment, nullifier_of_bet, sell_proceeds` |
| `partial_credit` | `merkle_root, nullifier, new_commitment, nullifier_of_bet, refund_amount` |
| `consolidate` | `merkle_root, nullifier[0..3], new_commitment` |

> Vault-injected public inputs (`fee`, `bet_amount`, `total_credit` components, `sell_proceeds`,
> `refund_amount`) are supplied by the contract — not the user — so a forged proof with any other
> value produces a `new_commitment` that fails verification. See `docs/zk-design.md`.

### Proof format

Proofs are ABI-encoded as `abi.encode(uint256[2] pA, uint256[2][2] pB, uint256[2] pC)` — 256 bytes. The G2 coordinate pairs are swapped relative to snarkjs ordering to match the EIP-197 BN254 precompile convention.

### Active circuit set (9)

`bet_auth`, `settlement_credit`, `withdrawal`, `bet_cancel`, `cancel_credit`, plus
`deposit` (FC-2), `position_close` (FC-1), `partial_credit` (FC-4), and `consolidate` (FC-8).
Each has a generated verifier in `packages/contracts/src/verifiers/<Name>Verifier.sol`.

> `circomlib` must be installed at `packages/circuits/node_modules` for the relative includes in
> `groth16/lib/*.circom` to resolve — it is declared in `packages/circuits/package.json`, so
> `pnpm install` provides it.

### Compiled artifacts & regeneration

The compiled `.wasm` and `.zkey` files are **not committed** (large binaries). They live in:
- `.wasm` files → `packages/frontend/public/circuits/*.wasm` (gitignored)
- `.zkey` files → `packages/frontend/public/zkeys/*.zkey` (gitignored)

Regenerate everything (verifiers + wasm + zkey + RealVerifier fixtures) via the Groth16 pipeline
(prerequisites: circom 2.1.6, snarkjs, and a Powers-of-Tau file):
```bash
# from the repo root
pnpm circuits:all
# == compile → setup → generate verifiers → copy wasm/zkey to frontend → regenerate fixtures
```
A fresh trusted setup changes every verifying key, so this regenerates all 9 verifiers, all
artifacts, and the `test/fixtures/*_proof.json` files together. Then verify on-chain:
```bash
cd packages/contracts && forge build && forge test --match-contract RealVerifierTest
```

> The old `regen-verifiers.sh` (barretenberg/UltraHonk-based) was removed — it violated the
> "no Honk/PLONK" rule. The Groth16 verifiers are generated by the snarkjs-based
> `generateVerifiers.ts` step of the Groth16 pipeline.

---

## Reference only: Noir / UltraPLONK (`Noir/`)

> **Not compiled. Not used for proof generation. Do not run `nargo compile` and copy outputs into the build.**

All Noir circuits live under the `Noir/` subdirectory:

```
Noir/
  Nargo.toml               — Noir workspace (members: lib, bet_auth, settlement_credit, withdrawal, bet_cancel, cancel_credit)
  lib/                     — shared Noir lib (package name `merkle`)
  bet_auth/                — main.nr + test.nr + Prover.toml
  settlement_credit/
  withdrawal/
  bet_cancel/
  cancel_credit/
  bench.sh                 — legacy UltraPLONK-vs-UltraHonk benchmark script (requires nargo; not part of the build)
```

These Noir circuits are kept as a canonical specification reference. They describe the same protocol logic as the Circom circuits and are useful for:

- Reading the constraint logic in a higher-level language
- Cross-checking the Circom implementation
- Potential future migration back to UltraPLONK or another Noir backend

The Noir circuits are **not wired into any build step**. The `pnpm circuits:compile` and `pnpm circuits:verifiers` commands in the root `package.json` currently have no effect on the active build (they target the Noir workspace). The verifier contracts in `packages/contracts/src/verifiers/` are Groth16 adapters generated from the Circom circuits — not from these Noir files.

If you switch back to a Noir-based backend, update `packages/contracts/src/verifiers/`, `packages/frontend/src/lib/prover.ts`, and `packages/frontend/package.json` accordingly. See `docs/Q16-proving-backend-comparison.md` for the benchmarking data behind the current choice.
