use dep::std::hash::poseidon::bn254;
use dep::merkle::merkle_verify;

mod test;

// Consolidate up to K=4 same-owner notes into a single output note (Groth16 slot 8, FC-8).
//
// Mirrors groth16/consolidate.circom. Spends each ACTIVE input note (publishing its
// nullifier) and emits ONE new commitment whose balance is the sum of the active
// inputs' balances, continuing slot 0's lineage:
//   new note = (secret[0], sum, nonce[0] + 1, owner).
// This is a value-preserving merge: no bet, no withdrawal, no token movement.
//
// Padding model (fixed-size circuit, variable real inputs):
//   - Active slot   (is_active[j]):  Merkle membership is enforced against merkle_root
//     and the published nullifier[j] is the real Poseidon2(secret[j], nonce[j]).
//   - Inactive slot (!is_active[j]): contributes 0 to the sum, the Merkle root check is
//     skipped (path may be dummy zeros), and nullifier[j] MUST be 0 (the Vault treats a
//     zero nullifier as "skip" and does not mark it spent).
//   - Slot 0 MUST be active (anchors the continued lineage; forbids forging a nonzero
//     output from all-inactive inputs).
//
// Double-spending the same note across two active slots is NOT prevented here; it is
// blocked on-chain because both slots publish the same nullifier and the NullifierRegistry
// reverts on the second markSpent. The Vault MUST mark every non-zero published nullifier
// spent (no de-duplication).
fn main(
    // Private inputs (per slot)
    secret: [Field; 4],
    balance: [u64; 4],
    nonce: [u64; 4],
    merkle_path: [[Field; 32]; 4],
    merkle_path_indices: [[u1; 32]; 4],
    is_active: [bool; 4],
    owner_address: Field, // shared: all of a wallet's notes carry the same owner_address

    // Public inputs
    merkle_root: pub Field,
    nullifier: pub [Field; 4], // inactive slots MUST be 0
    new_commitment: pub Field,
) {
    // Slot 0 anchors the continued lineage; forbids an all-inactive forge.
    assert(is_active[0], "Slot 0 must be active");

    let mut sum: u64 = 0;
    for j in 0..4 {
        // Recompute the input note commitment.
        let cm = bn254::hash_4([secret[j], balance[j] as Field, nonce[j] as Field, owner_address]);

        if is_active[j] {
            // Active: enforce Merkle membership and the real nullifier; add to the sum.
            let root = merkle_verify(cm, merkle_path[j], merkle_path_indices[j]);
            assert(root == merkle_root, "Invalid Merkle proof");

            let nh = bn254::hash_2([secret[j], nonce[j] as Field]);
            assert(nullifier[j] == nh, "Invalid nullifier");

            // u64 addition panics on overflow, mirroring the Circom sum range check.
            sum = sum + balance[j];
        } else {
            // Inactive: the published nullifier must be the Vault's skip sentinel (0).
            assert(nullifier[j] == 0, "Inactive slot nullifier must be zero");
        }
    }

    // Output note continues slot 0's lineage: (secret[0], sum, nonce[0] + 1, owner).
    let out_commitment = bn254::hash_4([secret[0], sum as Field, (nonce[0] + 1) as Field, owner_address]);
    assert(out_commitment == new_commitment, "Invalid new_commitment");
}
