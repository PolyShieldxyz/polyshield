use dep::std::hash::poseidon::bn254;
use dep::merkle::merkle_verify;

mod test;

// Settlement Credit circuit (Groth16 slot 1).
//
// Mirrors groth16/settlement_credit.circom. Credits a winning position's payout
// into the user's note. `total_credit` is Vault-verified on-chain
// (shares_held * payout_per_share == total_credit) before the verifier is called,
// so payout_per_share and shares_held are NOT circuit inputs — the Vault injects them.
fn main(
    // Private inputs
    secret: Field,
    balance_before_credit: u64,
    nonce: u64,
    // nonce of the note that was spent at bet-auth time (nullifier_of_bet = Poseidon2(secret, bet_nonce))
    bet_nonce: u64,
    merkle_path: [Field; 32],
    merkle_path_indices: [u1; 32],
    owner_address: Field,

    // Public inputs
    merkle_root: pub Field,
    nullifier: pub Field,
    new_commitment: pub Field,
    nullifier_of_bet: pub Field,
    market_id: pub Field,
    // payout_per_share and shares_held removed — the Vault injects them and verifies
    // shares_held * payout_per_share == total_credit on-chain before calling the verifier.
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

    // 4. SEC-001: bind nullifier_of_bet to a strictly earlier nonce on the same secret's
    //    chain, so bet_nonce is no longer a fully free witness. Settlement intentionally
    //    decouples the credited note from the bet receipt — a user may settle an open bet
    //    after later activity on the same deposit chain (see SettlementModal.tsx) — so we
    //    CANNOT bind bet_nonce == nonce - 1. Require bet_nonce < nonce: the referenced bet
    //    must sit at a strictly earlier nonce on this secret's chain. Holds in every
    //    legitimate flow and forces nonce >= 1. The Vault still binds nullifier_of_bet to a
    //    real, uncredited bet record on-chain.
    assert(bet_nonce < nonce, "bet_nonce must precede current nonce");
    let computed_bet_nullifier = bn254::hash_2([secret, bet_nonce as Field]);
    assert(computed_bet_nullifier == nullifier_of_bet, "Invalid nullifier_of_bet");

    // SEC-008: market_id stays public for on-chain binding only; intentionally unconstrained.
    let _ = market_id;
}
