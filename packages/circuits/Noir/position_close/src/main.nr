use dep::std::hash::poseidon::bn254;
use dep::merkle::merkle_verify;

mod test;

// Position Close credit (Groth16 slot 6, FC-1).
//
// Mirrors groth16/position_close.circom. A mirror of settlement_credit: the user
// spends their current note, proves membership, and recommits
// `balance + sell_proceeds`. `sell_proceeds` is the operator-reported SELL proceeds,
// Vault-injected on-chain from reportSold (the user cannot alter it in the proof).
// No market_id — closing is not tied to resolution. v1 only.
fn main(
    // Private inputs
    secret: Field,
    balance_before_credit: u64,
    nonce: u64,
    // nonce of the note spent at bet-auth time (nullifier_of_bet = Poseidon2(secret, bet_nonce))
    bet_nonce: u64,
    merkle_path: [Field; 32],
    merkle_path_indices: [u1; 32],
    owner_address: Field,

    // Public inputs
    merkle_root: pub Field,
    nullifier: pub Field,
    new_commitment: pub Field,
    nullifier_of_bet: pub Field,
    // Vault-injected from reportSold
    sell_proceeds: pub u64,
) {
    // 1. Verify the note is in the Merkle tree
    let old_commitment = bn254::hash_4([secret, balance_before_credit as Field, nonce as Field, owner_address]);
    let computed_root = merkle_verify(old_commitment, merkle_path, merkle_path_indices);
    assert(computed_root == merkle_root, "Invalid Merkle proof");

    // 2. Verify the nullifier
    let computed_nullifier = bn254::hash_2([secret, nonce as Field]);
    assert(computed_nullifier == nullifier, "Invalid nullifier");

    // 3. Verify the new commitment (balance credited by sell_proceeds, nonce incremented)
    let new_balance = balance_before_credit + sell_proceeds;
    let computed_new_commitment = bn254::hash_4([
        secret,
        new_balance as Field,
        (nonce + 1) as Field,
        owner_address,
    ]);
    assert(computed_new_commitment == new_commitment, "Invalid new_commitment");

    // 4. SEC-001: bind nullifier_of_bet to a strictly earlier nonce on the same secret's chain.
    //    As with settlement, the close spends the current free note on the bet's deposit chain
    //    (see ClosePositionModal.tsx), which may be several nonces ahead of the bet, so we
    //    CANNOT bind bet_nonce == nonce - 1. Require bet_nonce < nonce (holds in every
    //    legitimate flow; forces nonce >= 1).
    assert(bet_nonce < nonce, "bet_nonce must precede current nonce");
    let computed_bet_nullifier = bn254::hash_2([secret, bet_nonce as Field]);
    assert(computed_bet_nullifier == nullifier_of_bet, "Invalid nullifier_of_bet");
}
