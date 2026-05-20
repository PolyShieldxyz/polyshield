use dep::std::hash::poseidon::bn254;
use dep::merkle::merkle_verify;

mod test;

/// Bet Cancellation Credit circuit.
///
/// Restores bet_amount to the user's note when a FOK order failed to fill
/// after authorizeBet was confirmed on-chain. The Signing Layer operator
/// calls Vault.reportFOKFailure(nullifier_of_bet) first, which sets
/// betRecords.status = FAILED. The Vault then injects bet_amount from
/// storage -- the user cannot supply a different value.
fn main(
    // Private inputs
    secret: Field,
    // Post-bet balance: original_balance - bet_amount (debited at authorizeBet)
    current_balance: u64,
    // Post-bet nonce: original_nonce + 1
    nonce: u64,
    merkle_path: [Field; 32],
    merkle_path_indices: [u1; 32],

    // Public inputs
    merkle_root: pub Field,
    // Nullifier of the post-bet note: poseidon2(secret, nonce)
    nullifier: pub Field,
    new_commitment: pub Field,
    // Lookup key into betRecords (= nullifier of the pre-bet note)
    nullifier_of_bet: pub Field,
    // Vault-injected from betRecords[nullifier_of_bet].bet_amount -- not user-supplied
    bet_amount: pub u64,
) {
    // 1. Verify the post-bet note is in the Merkle tree
    let old_commitment = bn254::hash_3([secret, current_balance as Field, nonce as Field]);
    let computed_root = merkle_verify(old_commitment, merkle_path, merkle_path_indices);
    assert(computed_root == merkle_root, "Invalid Merkle proof");

    // 2. Verify the nullifier of the post-bet note
    let computed_nullifier = bn254::hash_2([secret, nonce as Field]);
    assert(computed_nullifier == nullifier, "Invalid nullifier");

    // 3. Verify the new commitment restores exactly bet_amount to the balance
    let restored_balance = current_balance + bet_amount;
    let computed_new_commitment = bn254::hash_3([
        secret,
        restored_balance as Field,
        (nonce + 1) as Field,
    ]);
    assert(computed_new_commitment == new_commitment, "Invalid new_commitment");

    // nullifier_of_bet is used by the Vault for betRecords lookup.
    let _ = nullifier_of_bet;
}
