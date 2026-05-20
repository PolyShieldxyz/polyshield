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

    // Public inputs
    merkle_root: pub Field,
    nullifier: pub Field,
    new_commitment: pub Field,
    nullifier_of_bet: pub Field,
    market_id: pub Field,
    payout_per_share: pub u64,
    // Vault-injected from betRecords[nullifier_of_bet].expected_shares -- not user-supplied
    shares_held: pub u64,
    total_credit: pub u64,
) {
    // 1. Verify the note is in the Merkle tree
    let old_commitment = bn254::hash_3([secret, balance_before_credit as Field, nonce as Field]);
    let computed_root = merkle_verify(old_commitment, merkle_path, merkle_path_indices);
    assert(computed_root == merkle_root, "Invalid Merkle proof");

    // 2. Verify the nullifier
    let computed_nullifier = bn254::hash_2([secret, nonce as Field]);
    assert(computed_nullifier == nullifier, "Invalid nullifier");

    // 3. Verify total_credit = shares_held * payout_per_share.
    //    Use Field to avoid potential overflow in the multiplication
    //    (values are bounded but product can exceed u64 at extreme prices).
    let computed_credit: Field = (shares_held as Field) * (payout_per_share as Field);
    assert(computed_credit == total_credit as Field, "Invalid total_credit");

    // 4. Verify the new commitment (balance credited, nonce incremented)
    let new_balance = balance_before_credit + total_credit;
    let computed_new_commitment = bn254::hash_3([
        secret,
        new_balance as Field,
        (nonce + 1) as Field,
    ]);
    assert(computed_new_commitment == new_commitment, "Invalid new_commitment");

    // nullifier_of_bet and market_id used by Vault for betRecords lookup.
    let _ = nullifier_of_bet;
    let _ = market_id;
}
