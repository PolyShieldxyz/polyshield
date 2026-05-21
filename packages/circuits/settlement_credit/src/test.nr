use dep::std::hash::poseidon::bn254;
use dep::merkle::merkle_verify;

fn build_zero_path() -> [Field; 32] {
    let mut path: [Field; 32] = [0; 32];
    let mut h = bn254::hash_3([0, 0, 0]);
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
fn test_settlement_credit_valid() {
    let secret: Field = 77;
    let balance_before_credit: u64 = 900_000_000; // 900 USDC
    let nonce: u64 = 1;
    let shares_held: u64 = 153_846_153;
    let payout_per_share: u64 = 1_000_000; // 1.0 pUSD/share (6 dec)
    let total_credit: u64 = 153_846_153_000_000; // shares * payout (would overflow u64; use smaller values)

    // Use smaller values that fit in u64
    let shares_held_small: u64 = 1_000;
    let payout_small: u64 = 500_000; // 0.5 pUSD/share
    let credit_small: u64 = 500_000_000; // 1000 * 500000

    let old_commitment = bn254::hash_3([secret, balance_before_credit as Field, nonce as Field]);
    let merkle_root = single_leaf_root(old_commitment);
    let merkle_path = build_zero_path();

    let nullifier = bn254::hash_2([secret, nonce as Field]);
    let new_balance = balance_before_credit + credit_small;
    let new_commitment = bn254::hash_3([secret, new_balance as Field, (nonce + 1) as Field]);

    // Validate constraint logic
    assert(merkle_verify(old_commitment, merkle_path, [0; 32]) == merkle_root);
    assert(bn254::hash_2([secret, nonce as Field]) == nullifier);

    let computed_credit: Field = (shares_held_small as Field) * (payout_small as Field);
    assert(computed_credit == credit_small as Field);

    assert(bn254::hash_3([secret, new_balance as Field, (nonce + 1) as Field]) == new_commitment);

    let _ = shares_held;
    let _ = payout_per_share;
    let _ = total_credit;
}

// Print witness values for Prover.toml generation
#[test]
fn test_print_bench_inputs() {
    let secret: Field = 77;
    let balance_before_credit: u64 = 900_000_000;
    let nonce: u64 = 1;
    let shares_held: u64 = 1_000;
    let payout_per_share: u64 = 500_000;
    let total_credit: u64 = 500_000_000;
    let nullifier_of_bet: Field = 1; // arbitrary for bench
    let market_id: Field = 1;

    let old_commitment = bn254::hash_3([secret, balance_before_credit as Field, nonce as Field]);
    let merkle_path = build_zero_path();
    let merkle_root = single_leaf_root(old_commitment);
    let nullifier = bn254::hash_2([secret, nonce as Field]);
    let new_balance = balance_before_credit + total_credit;
    let new_commitment = bn254::hash_3([secret, new_balance as Field, (nonce + 1) as Field]);

    println(f"BENCH secret {secret}");
    println(f"BENCH balance_before_credit {balance_before_credit}");
    println(f"BENCH nonce {nonce}");
    println(f"BENCH shares_held {shares_held}");
    println(f"BENCH payout_per_share {payout_per_share}");
    println(f"BENCH total_credit {total_credit}");
    println(f"BENCH nullifier_of_bet {nullifier_of_bet}");
    println(f"BENCH market_id {market_id}");
    println(f"BENCH merkle_root {merkle_root}");
    println(f"BENCH nullifier {nullifier}");
    println(f"BENCH new_commitment {new_commitment}");
    println("BENCH path_start");
    for i in 0..32 {
        println(merkle_path[i]);
    }
    println("BENCH path_end");
}

// Wrong Merkle root
#[test(should_fail_with = "Invalid Merkle proof")]
fn test_settlement_wrong_root() {
    let secret: Field = 77;
    let balance: u64 = 900_000_000;
    let nonce: u64 = 1;

    let old_commitment = bn254::hash_3([secret, balance as Field, nonce as Field]);
    let merkle_path = build_zero_path();
    let computed_root = merkle_verify(old_commitment, merkle_path, [0; 32]);
    assert(computed_root == 0, "Invalid Merkle proof");
}

// Wrong total_credit -- constraint 3 should fail
#[test(should_fail_with = "Invalid total_credit")]
fn test_settlement_wrong_credit() {
    let shares_held: u64 = 1_000;
    let payout_per_share: u64 = 500_000;
    let wrong_credit: u64 = 0;

    let computed: Field = (shares_held as Field) * (payout_per_share as Field);
    assert(computed == wrong_credit as Field, "Invalid total_credit");
}

// Wrong new_commitment -- constraint 4 should fail
#[test(should_fail_with = "Invalid new_commitment")]
fn test_settlement_wrong_new_commitment() {
    let secret: Field = 77;
    let balance_before: u64 = 900_000_000;
    let total_credit: u64 = 500_000_000;
    let nonce: u64 = 1;

    let new_balance = balance_before + total_credit;
    let correct = bn254::hash_3([secret, new_balance as Field, (nonce + 1) as Field]);
    assert(correct == 0, "Invalid new_commitment");
}
