# packages/circuits

This directory contains two sets of ZK circuits for Polyshield. Only the Groth16 set is active in the current build.

---

## Active: Groth16 / Circom (`groth16/`)

**These are the circuits used in production.** Compiled with `circom 2.1.6`, proven with `snarkjs` (Groth16 on BN254), verified on-chain by the five adapter verifier contracts in `packages/contracts/src/verifiers/`.

```
groth16/
  bet_auth.circom          — Bet authorization: note balance check, nullifier, new commitment
  withdrawal.circom        — Withdrawal to depositing address only (W-to-W)
  settlement_credit.circom — Winning position settlement credit
  bet_cancel.circom        — Restore balance for a failed FOK bet
  cancel_credit.circom     — N/A market resolution credit
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
| `bet_auth` | `merkle_root, nullifier, new_commitment, bet_amount, price, expected_shares, market_id, outcome_side, position_id` |
| `withdrawal` | `merkle_root, nullifier, withdrawal_amount, recipient_hash, new_commitment` |
| `settlement_credit` | `merkle_root, nullifier, new_commitment, nullifier_of_bet, market_id, total_credit` |
| `bet_cancel` | `merkle_root, nullifier, new_commitment, nullifier_of_bet, bet_amount` |
| `cancel_credit` | `merkle_root, nullifier, new_commitment, nullifier_of_bet, market_id, bet_amount` |

### Proof format

Proofs are ABI-encoded as `abi.encode(uint256[2] pA, uint256[2][2] pB, uint256[2] pC)` — 256 bytes. The G2 coordinate pairs are swapped relative to snarkjs ordering to match the EIP-197 BN254 precompile convention.

### Compiled artifacts

The compiled `.wasm` and `.zkey` files are **not committed** (they are large binaries). They live in:
- `.wasm` files → `packages/frontend/public/circuits/*.wasm` (gitignored, ~2.4 MB each)
- `.zkey` files → `packages/frontend/public/zkeys/*.zkey` (gitignored, ~8.7 MB each)

To regenerate them, re-run the Groth16 setup pipeline in `Benchmarking/groth16/` and copy the outputs:
```bash
# From Benchmarking/groth16/
pnpm compile:circuits    # circom → r1cs + wasm
pnpm setup:circuits      # snarkjs groth16 setup → zkeys

# Copy to frontend
for c in bet_auth withdrawal settlement_credit bet_cancel cancel_credit; do
  cp artifacts/${c}/${c}_js/${c}.wasm ../../packages/frontend/public/circuits/
  cp setup/${c}.zkey ../../packages/frontend/public/zkeys/
done
```

---

## Reference only: Noir / UltraPLONK (`bet_auth/`, `withdrawal/`, etc.)

> **Not compiled. Not used for proof generation. Do not run `nargo compile` and copy outputs into the build.**

The Noir circuits in the top-level subdirectories (`bet_auth/`, `withdrawal/`, `settlement_credit/`, `bet_cancel/`, `cancel_credit/`, `lib/`) are kept as a canonical specification reference. They describe the same protocol logic as the Circom circuits and are useful for:

- Reading the constraint logic in a higher-level language
- Cross-checking the Circom implementation
- Potential future migration back to UltraPLONK or another Noir backend

The Noir circuits are **not wired into any build step**. The `pnpm circuits:compile` and `pnpm circuits:verifiers` commands in the root `package.json` currently have no effect on the active build (they target the Noir workspace). The verifier contracts in `packages/contracts/src/verifiers/` are Groth16 adapters generated from the Circom circuits — not from these Noir files.

If you switch back to a Noir-based backend, update `packages/contracts/src/verifiers/`, `packages/frontend/src/lib/prover.ts`, and `packages/frontend/package.json` accordingly. See `docs/Q16-proving-backend-comparison.md` for the benchmarking data behind the current choice.
