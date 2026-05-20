use dep::std::hash::poseidon::bn254;
use dep::merkle::merkle_verify;

mod test;

fn main(
    // Private inputs
    secret: Field,
    current_balance: u64,
    nonce: u64,
    merkle_path: [Field; 32],
    merkle_path_indices: [u1; 32],
    // Remainder witness for floor-division verification:
    // share_remainder = (bet_amount * 1e8) mod price
    // Prover computes this; circuit verifies the floor via Field equality + u64 range check.
    share_remainder: u64,

    // Public inputs
    merkle_root: pub Field,
    nullifier: pub Field,
    new_commitment: pub Field,
    bet_amount: pub u64,
    price: pub u64,
    expected_shares: pub u64,
    market_id: pub Field,
    outcome_side: pub u8,
    position_id: pub Field,
) {
    // 1. Verify the old note commitment is in the Merkle tree
    let old_commitment = bn254::hash_3([secret, current_balance as Field, nonce as Field]);
    let computed_root = merkle_verify(old_commitment, merkle_path, merkle_path_indices);
    assert(computed_root == merkle_root, "Invalid Merkle proof");

    // 2. Verify the nullifier
    let computed_nullifier = bn254::hash_2([secret, nonce as Field]);
    assert(computed_nullifier == nullifier, "Invalid nullifier");

    // 3. Verify sufficient balance
    assert(current_balance >= bet_amount, "Insufficient balance");

    // 4. Verify expected_shares = floor(bet_amount * 1e8 / price).
    //    Noir 0.37 has no u128; use Field arithmetic (no overflow since values << 2^254)
    //    and a u64 range check on the remainder.
    //    Constraint: expected_shares * price + share_remainder == bet_amount * 1e8 (Field)
    //    Range: 0 <= share_remainder < price (u64)
    let lhs: Field = (expected_shares as Field) * (price as Field) + (share_remainder as Field);
    let rhs: Field = (bet_amount as Field) * 100_000_000;
    assert(lhs == rhs, "Invalid expected_shares");
    assert(share_remainder < price, "Invalid share_remainder range");

    // 5. Verify the new commitment (balance decremented, nonce incremented)
    let new_balance = current_balance - bet_amount;
    let computed_new_commitment = bn254::hash_3([
        secret,
        new_balance as Field,
        (nonce + 1) as Field,
    ]);
    assert(computed_new_commitment == new_commitment, "Invalid new_commitment");

    // market_id, outcome_side, position_id are bound as public inputs.
    // The Signing Layer executes only the bet matching these exact parameters
    // from the on-chain BetAuthorized event.
    let _ = market_id;
    let _ = outcome_side;
    let _ = position_id;
}
