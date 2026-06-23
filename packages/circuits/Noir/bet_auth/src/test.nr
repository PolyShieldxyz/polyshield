use dep::std::hash::poseidon::bn254;
use dep::merkle::merkle_verify;

fn zero_leaf() -> Field {
    0
}

fn build_zero_path() -> [Field; 32] {
    let mut path: [Field; 32] = [0; 32];
    let mut h = zero_leaf();
    for i in 0..32 {
        path[i] = h;
        h = bn254::hash_2([h, h]);
    }
    path
}

fn single_leaf_root(leaf: Field) -> Field {
    merkle_verify(leaf, build_zero_path(), [0; 32])
}

// Valid proof (happy path)
#[test]
fn test_bet_auth_valid() {
    let secret: Field = 42;
    let current_balance: u64 = 1_000_000_000; // 1000 USDC (6 dec)
    let nonce: u64 = 0;
    let bet_amount: u64 = 100_000_000;        // 100 USDC
    let price: u64 = 65_000_000;              // 0.65 in 1e8
    // expected_shares = floor(100_000_000 * 100_000_000 / 65_000_000) = 153_846_153
    let expected_shares_correct: u64 = 153_846_153;
    // share_remainder = 10_000_000_000_000_000 - 153_846_153 * 65_000_000
    //                 = 10_000_000_000_000_000 - 9_999_999_945_000_000
    //                 = 55_000_000
    let share_remainder: u64 = 55_000_000;
    // FC-10 Vault-injected fee = bet_amount * betFeeBps/10000 + relayGasFeeUSDC.
    // Example: betFeeBps = 20, relayGasFeeUSDC = 0 -> 100_000_000 * 20/10000 = 200_000.
    let fee: u64 = 200_000;
    let owner_address: Field = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    let old_commitment = bn254::hash_4([secret, current_balance as Field, nonce as Field, owner_address]);
    let merkle_root = single_leaf_root(old_commitment);
    let merkle_path = build_zero_path();
    let merkle_path_indices: [u1; 32] = [0; 32];

    let nullifier = bn254::hash_2([secret, nonce as Field]);
    let new_balance = current_balance - bet_amount - fee;
    let new_commitment = bn254::hash_4([secret, new_balance as Field, (nonce + 1) as Field, owner_address]);

    // Validate constraint logic (mirrors main() assertions)
    assert(merkle_verify(old_commitment, merkle_path, merkle_path_indices) == merkle_root);
    assert(bn254::hash_2([secret, nonce as Field]) == nullifier);
    assert(current_balance >= bet_amount);
    assert(price > 0);

    // Floor division verification: expected_shares * price + remainder == bet_amount * 1e8
    let lhs: Field = (expected_shares_correct as Field) * (price as Field) + (share_remainder as Field);
    let rhs: Field = (bet_amount as Field) * 100_000_000;
    assert(lhs == rhs);
    assert(share_remainder < price);

    assert(bn254::hash_4([secret, new_balance as Field, (nonce + 1) as Field, owner_address]) == new_commitment);

    let _ = merkle_root;
}

// Wrong Merkle root -- constraint 1 should fail
#[test(should_fail_with = "Invalid Merkle proof")]
fn test_bet_auth_wrong_root() {
    let secret: Field = 42;
    let current_balance: u64 = 1_000_000_000;
    let nonce: u64 = 0;
    let owner_address: Field = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    let old_commitment = bn254::hash_4([secret, current_balance as Field, nonce as Field, owner_address]);
    let merkle_path = build_zero_path();
    let merkle_path_indices: [u1; 32] = [0; 32];

    let bad_root: Field = 1234;

    let computed_root = merkle_verify(old_commitment, merkle_path, merkle_path_indices);
    assert(computed_root == bad_root, "Invalid Merkle proof");
}

// Wrong nullifier -- constraint 2 should fail
#[test(should_fail_with = "Invalid nullifier")]
fn test_bet_auth_wrong_nullifier() {
    let secret: Field = 42;
    let nonce: u64 = 0;
    let bad_nullifier: Field = 9999;

    let computed_nullifier = bn254::hash_2([secret, nonce as Field]);
    assert(computed_nullifier == bad_nullifier, "Invalid nullifier");
}

// Insufficient balance -- constraint 3 should fail
#[test(should_fail_with = "Insufficient balance")]
fn test_bet_auth_insufficient_balance() {
    let current_balance: u64 = 50_000_000;
    let bet_amount: u64 = 100_000_000; // exceeds balance
    assert(current_balance >= bet_amount, "Insufficient balance");
}

// Zero price -- SEC-003 (constraint 4) should fail
#[test(should_fail_with = "Price must be positive")]
fn test_bet_auth_zero_price() {
    let price: u64 = 0;
    assert(price > 0, "Price must be positive");
}

// Wrong expected_shares -- constraint 5 should fail
#[test(should_fail_with = "Invalid expected_shares")]
fn test_bet_auth_wrong_shares() {
    let bet_amount: u64 = 100_000_000;
    let price: u64 = 65_000_000;
    let wrong_shares: u64 = 999;
    let wrong_remainder: u64 = 0;

    let lhs: Field = (wrong_shares as Field) * (price as Field) + (wrong_remainder as Field);
    let rhs: Field = (bet_amount as Field) * 100_000_000;
    assert(lhs == rhs, "Invalid expected_shares");
}

// Print witness values for Prover.toml generation
#[test]
fn test_print_bench_inputs() {
    let secret: Field = 42;
    let current_balance: u64 = 1_000_000_000;
    let nonce: u64 = 0;
    let bet_amount: u64 = 100_000_000;
    let price: u64 = 65_000_000;
    let expected_shares: u64 = 153_846_153;
    let share_remainder: u64 = 55_000_000;
    let fee: u64 = 200_000;
    let market_id: Field = 1;
    let outcome_side: u8 = 1;
    let position_id: Field = 2;
    let owner_address: Field = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    let old_commitment = bn254::hash_4([secret, current_balance as Field, nonce as Field, owner_address]);
    let merkle_path = build_zero_path();
    let merkle_root = single_leaf_root(old_commitment);
    let nullifier = bn254::hash_2([secret, nonce as Field]);
    let new_balance = current_balance - bet_amount - fee;
    let new_commitment = bn254::hash_4([secret, new_balance as Field, (nonce + 1) as Field, owner_address]);

    println(f"BENCH secret {secret}");
    println(f"BENCH current_balance {current_balance}");
    println(f"BENCH nonce {nonce}");
    println(f"BENCH owner_address {owner_address}");
    println(f"BENCH bet_amount {bet_amount}");
    println(f"BENCH price {price}");
    println(f"BENCH expected_shares {expected_shares}");
    println(f"BENCH share_remainder {share_remainder}");
    println(f"BENCH fee {fee}");
    println(f"BENCH market_id {market_id}");
    println(f"BENCH outcome_side {outcome_side}");
    println(f"BENCH position_id {position_id}");
    println(f"BENCH merkle_root {merkle_root}");
    println(f"BENCH nullifier {nullifier}");
    println(f"BENCH new_commitment {new_commitment}");
    println("BENCH path_start");
    for i in 0..32 {
        println(merkle_path[i]);
    }
    println("BENCH path_end");
}

// Wrong new_commitment -- constraint 6 should fail
#[test(should_fail_with = "Invalid new_commitment")]
fn test_bet_auth_wrong_new_commitment() {
    let secret: Field = 42;
    let current_balance: u64 = 1_000_000_000;
    let nonce: u64 = 0;
    let bet_amount: u64 = 100_000_000;
    let fee: u64 = 200_000;
    let owner_address: Field = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    let new_balance = current_balance - bet_amount - fee;
    let correct = bn254::hash_4([secret, new_balance as Field, (nonce + 1) as Field, owner_address]);
    let wrong: Field = 0;

    assert(correct == wrong, "Invalid new_commitment");
}
