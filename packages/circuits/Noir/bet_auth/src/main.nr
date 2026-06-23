use dep::std::hash::poseidon::bn254;
use dep::merkle::merkle_verify;

mod test;

// Bet Authorization circuit (Groth16 slot 0).
//
// Mirrors groth16/bet_auth.circom. The user spends their current note, proves it
// is in the Merkle tree, debits `bet_amount + fee`, and recommits the remainder.
//
// `fee` is Vault-injected (FC-10): fee = bet_amount * betFeeBps / 10000 + relayGasFeeUSDC,
// supplied by the contract as a public input. A user cannot forge a proof with a
// different fee — their new_commitment would not match the Vault-injected fee and
// verification fails. This is identical to the way bet_amount is injected for
// cancellations. See docs/zk-design.md and CLAUDE.md (Fee model).
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
    owner_address: Field,

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
    // Vault-injected protocol fee + relay-gas reimbursement, in USDC (6dp). See FC-10.
    fee: pub u64,
) {
    // 1. Verify the old note commitment is in the Merkle tree
    let old_commitment = bn254::hash_4([secret, current_balance as Field, nonce as Field, owner_address]);
    let computed_root = merkle_verify(old_commitment, merkle_path, merkle_path_indices);
    assert(computed_root == merkle_root, "Invalid Merkle proof");

    // 2. Verify the nullifier
    let computed_nullifier = bn254::hash_2([secret, nonce as Field]);
    assert(computed_nullifier == nullifier, "Invalid nullifier");

    // 3. Verify sufficient balance for the bet itself. The fee underflow is caught by the
    //    u64 subtraction in step 6 (which panics if current_balance < bet_amount + fee),
    //    mirroring the Circom AssertBits(64) range check on new_balance.
    assert(current_balance >= bet_amount, "Insufficient balance");

    // 4. SEC-003: require price > 0 explicitly, rather than relying on the emergent
    //    `share_remainder < price` bound to reject a zero price.
    assert(price > 0, "Price must be positive");

    // 5. Verify expected_shares = floor(bet_amount * 1e8 / price).
    //    Noir has no native u128 here; use Field arithmetic (no overflow since values << 2^254)
    //    and a u64 range check on the remainder.
    //    Constraint: expected_shares * price + share_remainder == bet_amount * 1e8 (Field)
    //    Range:      0 <= share_remainder < price (u64)
    let lhs: Field = (expected_shares as Field) * (price as Field) + (share_remainder as Field);
    let rhs: Field = (bet_amount as Field) * 100_000_000;
    assert(lhs == rhs, "Invalid expected_shares");
    assert(share_remainder < price, "Invalid share_remainder range");

    // 6. Verify the new commitment (balance decremented by bet_amount + fee, nonce incremented).
    //    The u64 subtraction panics on underflow, enforcing current_balance >= bet_amount + fee.
    let new_balance = current_balance - bet_amount - fee;
    let computed_new_commitment = bn254::hash_4([
        secret,
        new_balance as Field,
        (nonce + 1) as Field,
        owner_address,
    ]);
    assert(computed_new_commitment == new_commitment, "Invalid new_commitment");

    // SEC-008: market_id, outcome_side, position_id stay public for on-chain binding only;
    // they are intentionally unconstrained in-circuit (the Vault binds them on-chain). The
    // Signing Layer executes only the bet matching these exact parameters from the
    // on-chain BetAuthorized event.
    let _ = market_id;
    let _ = outcome_side;
    let _ = position_id;
}
