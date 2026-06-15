use dep::std::hash::poseidon::bn254;
use dep::merkle::merkle_verify;

mod test;

/// N/A Cancellation Credit circuit.
///
/// Restores bet_amount to the user's note when Polymarket resolves a market
/// as N/A (cancelled). The Vault verifies the CTF condition has all-zero
/// payoutNumerators on-chain before accepting this proof -- no trusted operator
/// action required.
fn main(
    // Private inputs
    secret: Field,
    // Post-bet balance: original_balance - bet_amount
    current_balance: u64,
    // Post-bet nonce: original_nonce + 1
    nonce: u64,
    merkle_path: [Field; 32],
    merkle_path_indices: [u1; 32],
    owner_address: Field,

    // Public inputs
    merkle_root: pub Field,
    nullifier: pub Field,
    new_commitment: pub Field,
    // Lookup key into betRecords (= nullifier of the pre-bet note)
    nullifier_of_bet: pub Field,
    // Vault checks betRecords[nullifier_of_bet].market_id == market_id
    market_id: pub Field,
    // Vault-injected from betRecords[nullifier_of_bet].bet_amount -- not user-supplied
    bet_amount: pub u64,
) {
    // 1. Verify the post-bet note is in the Merkle tree
    let old_commitment = bn254::hash_4([secret, current_balance as Field, nonce as Field, owner_address]);
    let computed_root = merkle_verify(old_commitment, merkle_path, merkle_path_indices);
    assert(computed_root == merkle_root, "Invalid Merkle proof");

    // 2. Verify the nullifier
    let computed_nullifier = bn254::hash_2([secret, nonce as Field]);
    assert(computed_nullifier == nullifier, "Invalid nullifier");

    // 3. Verify the new commitment restores exactly bet_amount to the balance
    let restored_balance = current_balance + bet_amount;
    let computed_new_commitment = bn254::hash_4([
        secret,
        restored_balance as Field,
        (nonce + 1) as Field,
        owner_address,
    ]);
    assert(computed_new_commitment == new_commitment, "Invalid new_commitment");

    // nullifier_of_bet and market_id used by Vault for betRecords lookup and N/A check.
    let _ = nullifier_of_bet;
    let _ = market_id;
}
