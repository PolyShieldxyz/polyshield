use dep::std::hash::poseidon::bn254;
use dep::merkle::merkle_verify;

mod test;

fn main(
    // Private inputs
    secret: Field,
    balance_before_credit: u64,
    nonce: u64,
    merkle_path: [Field; 32],
    merkle_path_indices: [u1; 32],
    owner_address: Field,

    // Public inputs
    merkle_root: pub Field,
    nullifier: pub Field,
    new_commitment: pub Field,
    nullifier_of_bet: pub Field,
    market_id: pub Field,
    // payout_per_share and shares_held removed. Vault verifies
    // shares_held * payout_per_share == total_credit on-chain before calling the verifier
    total_credit: pub u64,
) {
    // 1. Verify the note is in the Merkle tree
    let old_commitment = bn254::hash_4([secret, balance_before_credit as Field, nonce as Field, owner_address]);
    let computed_root = merkle_verify(old_commitment, merkle_path, merkle_path_indices);
    assert(computed_root == merkle_root, "Invalid Merkle proof");

    // 2. Verify the nullifier
    let computed_nullifier = bn254::hash_2([secret, nonce as Field]);
    assert(computed_nullifier == nullifier, "Invalid nullifier");

    // 3. Verify the new commitment (balance credited, nonce incremented)
    let new_balance = balance_before_credit + total_credit;
    let computed_new_commitment = bn254::hash_4([
        secret,
        new_balance as Field,
        (nonce + 1) as Field,
        owner_address,
    ]);
    assert(computed_new_commitment == new_commitment, "Invalid new_commitment");

    // nullifier_of_bet and market_id used by Vault for betRecords lookup.
    let _ = nullifier_of_bet;
    let _ = market_id;
}
