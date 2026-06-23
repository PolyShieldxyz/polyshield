use dep::std::hash::poseidon::bn254;
use dep::merkle::merkle_verify;

mod test;

/// Bet Cancellation Credit circuit (Groth16 slot 3).
///
/// Mirrors groth16/bet_cancel.circom. Restores bet_amount to the user's note when
/// a FOK order failed to fill after authorizeBet was confirmed on-chain. The
/// Signing Layer attests FAILED off-chain (FC-9); the Vault injects bet_amount from
/// betRecords[nullifier_of_bet].bet_amount — the user cannot supply a different value.
fn main(
    // Private inputs
    secret: Field,
    // Current note balance (post-bet: original_balance - bet_amount, debited at authorizeBet)
    current_balance: u64,
    // Current note nonce — may be several actions after the bet
    nonce: u64,
    merkle_path: [Field; 32],
    merkle_path_indices: [u1; 32],
    owner_address: Field,
    // private: nonce of the note the bet was made from (nullifier_of_bet = Poseidon2(secret, bet_nonce))
    bet_nonce: u64,

    // Public inputs
    merkle_root: pub Field,
    // Nullifier of the current note: Poseidon2(secret, nonce)
    nullifier: pub Field,
    new_commitment: pub Field,
    // Lookup key into betRecords (= nullifier of the pre-bet note)
    nullifier_of_bet: pub Field,
    // Vault-injected from betRecords[nullifier_of_bet].bet_amount — not user-supplied
    bet_amount: pub u64,
) {
    // 1. Verify the current note is in the Merkle tree
    let old_commitment = bn254::hash_4([secret, current_balance as Field, nonce as Field, owner_address]);
    let computed_root = merkle_verify(old_commitment, merkle_path, merkle_path_indices);
    assert(computed_root == merkle_root, "Invalid Merkle proof");

    // 2. Verify the nullifier of the current note
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

    // 4. Decoupled reclaim: the bet was made from the note at `bet_nonce`; we spend the
    //    CURRENT note (`nonce`), which may be several actions later — so a subsequent action
    //    that consumed the immediate post-bet note no longer orphans the reclaim. `bet_nonce`
    //    is a private witness; require bet_nonce < nonce (the bet predates the current note;
    //    this also guarantees nonce >= 1, replacing the old SEC-002 nonce>=1 check). The Vault
    //    still binds nullifier_of_bet to a real, uncredited bet record (double-credit guard).
    assert(bet_nonce < nonce, "bet_nonce must precede current nonce");
    let computed_bet_nullifier = bn254::hash_2([secret, bet_nonce as Field]);
    assert(computed_bet_nullifier == nullifier_of_bet, "Invalid nullifier_of_bet");
}
