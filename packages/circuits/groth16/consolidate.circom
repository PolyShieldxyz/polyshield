pragma circom 2.1.6;

include "./lib/checks.circom";
include "./lib/merkle.circom";
include "./lib/note.circom";

// Consolidate up to K same-owner notes into a single output note.
//
// Spends each ACTIVE input note (publishing its nullifier) and emits ONE new
// commitment whose balance is the sum of the active inputs' balances,
// continuing slot 0's lineage: new note = (secret[0], sum, nonce[0]+1, owner).
//
// This is a value-preserving merge: no bet, no withdrawal, no token movement.
//
// Padding model (fixed-size circuit, variable real inputs):
//   - is_active[j] is a strict boolean.
//   - Active slot   (is_active[j]==1): Merkle membership is enforced against
//     merkle_root and the published nullifier[j] is the real Poseidon2(secret,nonce).
//   - Inactive slot (is_active[j]==0): contributes 0 to the sum, the Merkle root
//     check is gated off (path may be dummy zeros), and nullifier[j] MUST be 0
//     (the Vault treats a zero nullifier as "skip" and does not mark it spent).
//   - Slot 0 MUST be active (anchors the continued lineage; forbids forging a
//     nonzero output from all-inactive inputs).
//
// Double-spending the same note across two active slots is NOT prevented here;
// it is blocked on-chain because both slots publish the same nullifier and the
// NullifierRegistry reverts AlreadySpent on the second markSpent. The Vault MUST
// therefore mark every non-zero published nullifier spent (no de-duplication).
template Consolidate(K) {
    // Private inputs (per slot)
    signal input secret[K];
    signal input balance[K];
    signal input nonce[K];
    signal input merkle_path[K][32];
    signal input merkle_path_indices[K][32];
    signal input is_active[K];
    signal input owner_address;          // shared: all of a wallet's notes carry the same owner_address

    // Public inputs
    signal input merkle_root;
    signal input nullifier[K];           // inactive slots MUST be 0
    signal input new_commitment;

    component balBits[K];
    component nonceBits[K];
    component cm[K];
    component mp[K];
    component nh[K];
    signal eff[K];
    signal partial[K];

    for (var j = 0; j < K; j++) {
        // is_active is a strict boolean — defends the multiplicative gates below.
        is_active[j] * (is_active[j] - 1) === 0;

        // u64 range checks on the note fields.
        balBits[j] = AssertBits(64);
        balBits[j].in <== balance[j];
        nonceBits[j] = AssertBits(64);
        nonceBits[j].in <== nonce[j];

        // Recompute the input note commitment.
        cm[j] = NoteCommitment();
        cm[j].secret <== secret[j];
        cm[j].balance <== balance[j];
        cm[j].nonce <== nonce[j];
        cm[j].owner_address <== owner_address;

        // Merkle membership, GATED by is_active:
        //   active   -> mp[j].root must equal merkle_root (note is in the tree)
        //   inactive -> unconstrained (the dummy path is ignored)
        mp[j] = PoseidonMerklePath(32);
        mp[j].leaf <== cm[j].out;
        for (var i = 0; i < 32; i++) {
            mp[j].siblings[i] <== merkle_path[j][i];
            mp[j].pathIndices[i] <== merkle_path_indices[j][i];
        }
        is_active[j] * (mp[j].root - merkle_root) === 0;

        // Nullifier, GATED:
        //   active   -> published nullifier is the real Poseidon2(secret, nonce)
        //   inactive -> published nullifier is 0 (the Vault's skip sentinel)
        nh[j] = NullifierHash();
        nh[j].secret <== secret[j];
        nh[j].nonce <== nonce[j];
        nullifier[j] === is_active[j] * nh[j].out;

        // Effective balance: 0 when inactive. Running prefix sum.
        eff[j] <== is_active[j] * balance[j];
        if (j == 0) {
            partial[0] <== eff[0];
        } else {
            partial[j] <== partial[j - 1] + eff[j];
        }
    }

    // Slot 0 anchors the continued lineage; forbids an all-inactive forge.
    is_active[0] === 1;

    // Summed balance, u64 range-checked (guards overflow of the merged balance).
    signal sum;
    sum <== partial[K - 1];
    component sumBits = AssertBits(64);
    sumBits.in <== sum;

    // Output note continues slot 0's lineage: (secret[0], sum, nonce[0]+1, owner).
    component nextNonce = IncrementU64();
    nextNonce.in <== nonce[0];

    component outCommitment = NoteCommitment();
    outCommitment.secret <== secret[0];
    outCommitment.balance <== sum;
    outCommitment.nonce <== nextNonce.out;
    outCommitment.owner_address <== owner_address;
    outCommitment.out === new_commitment;
}

component main {public [merkle_root, nullifier, new_commitment]} = Consolidate(4);
