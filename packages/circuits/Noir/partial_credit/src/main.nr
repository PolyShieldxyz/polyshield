use dep::std::hash::poseidon::bn254;
use dep::merkle::merkle_verify;

mod test;

// Partial-Fill Credit circuit (Groth16 slot 7, FC-4 native limit orders, GTC/GTD).
//
// Mirrors groth16/partial_credit.circom. Constraint-identical to bet_cancel: the
// user spends the post-bet note, proves membership, and recommits
// `current_balance + refund_amount`. `refund_amount` is the unfilled remainder of a
// partially-filled limit order (bet_amount - spent_amount), Vault-injected on-chain
// from the operator's PARTIAL attestation (FC-9) — the user cannot alter it in the
// proof. Public-input shape matches bet_cancel.
fn main(
    // Private inputs
    secret: Field,
    current_balance: u64,
    nonce: u64,
    merkle_path: [Field; 32],
    merkle_path_indices: [u1; 32],
    owner_address: Field,
    // private: nonce of the note the bet was made from (nullifier_of_bet = Poseidon2(secret, bet_nonce))
    bet_nonce: u64,

    // Public inputs
    merkle_root: pub Field,
    nullifier: pub Field,
    new_commitment: pub Field,
    nullifier_of_bet: pub Field,
    // Vault-injected from reportPartialFill: refund_amount = bet_amount - spent_amount
    refund_amount: pub u64,
) {
    // 1. Verify the current (post-bet) note is in the Merkle tree
    let old_commitment = bn254::hash_4([secret, current_balance as Field, nonce as Field, owner_address]);
    let computed_root = merkle_verify(old_commitment, merkle_path, merkle_path_indices);
    assert(computed_root == merkle_root, "Invalid Merkle proof");

    // 2. Verify the nullifier
    let computed_nullifier = bn254::hash_2([secret, nonce as Field]);
    assert(computed_nullifier == nullifier, "Invalid nullifier");

    // 3. Verify the new commitment restores exactly refund_amount to the balance
    let restored_balance = current_balance + refund_amount;
    let computed_new_commitment = bn254::hash_4([
        secret,
        restored_balance as Field,
        (nonce + 1) as Field,
        owner_address,
    ]);
    assert(computed_new_commitment == new_commitment, "Invalid new_commitment");

    // 4. Decoupled reclaim (see bet_cancel): spend the CURRENT note (`nonce`) and bind the bet
    //    via the private `bet_nonce` instead of `nonce - 1`, so a later action that consumed the
    //    post-bet note no longer orphans the refund. Require bet_nonce < nonce (bet predates the
    //    current note; also guarantees nonce >= 1). The Vault binds nullifier_of_bet to a real record.
    assert(bet_nonce < nonce, "bet_nonce must precede current nonce");
    let computed_bet_nullifier = bn254::hash_2([secret, bet_nonce as Field]);
    assert(computed_bet_nullifier == nullifier_of_bet, "Invalid nullifier_of_bet");
}
