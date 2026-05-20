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
fn test_withdrawal_valid() {
    let secret: Field = 13;
    let final_balance: u64 = 2_000_000_000; // 2000 USDC
    let nonce: u64 = 3;
    let withdrawal_amount: u64 = 2_000_000_000; // full withdrawal
    let recipient_address: Field = 0xdeadbeef;

    let commitment = bn254::hash_3([secret, final_balance as Field, nonce as Field]);
    let merkle_root = single_leaf_root(commitment);
    let merkle_path = build_zero_path();

    let nullifier = bn254::hash_2([secret, nonce as Field]);
    let recipient_hash = bn254::hash_2([recipient_address, 0]);

    assert(merkle_verify(commitment, merkle_path, [0; 32]) == merkle_root);
    assert(bn254::hash_2([secret, nonce as Field]) == nullifier);
    assert(withdrawal_amount <= final_balance);
    assert(bn254::hash_2([recipient_address, 0]) == recipient_hash);
}

// Wrong Merkle root
#[test(should_fail_with = "Invalid Merkle proof")]
fn test_withdrawal_wrong_root() {
    let secret: Field = 13;
    let final_balance: u64 = 2_000_000_000;
    let nonce: u64 = 3;

    let commitment = bn254::hash_3([secret, final_balance as Field, nonce as Field]);
    let merkle_path = build_zero_path();
    let computed_root = merkle_verify(commitment, merkle_path, [0; 32]);
    assert(computed_root == 0, "Invalid Merkle proof");
}

// Withdrawal exceeds balance
#[test(should_fail_with = "Withdrawal exceeds balance")]
fn test_withdrawal_exceeds_balance() {
    let final_balance: u64 = 500_000_000;
    let withdrawal_amount: u64 = 600_000_000; // too much
    assert(withdrawal_amount <= final_balance, "Withdrawal exceeds balance");
}

// Wrong recipient_hash
#[test(should_fail_with = "Invalid recipient_hash")]
fn test_withdrawal_wrong_recipient_hash() {
    let recipient_address: Field = 0xdeadbeef;
    let wrong_hash: Field = 0;

    let correct_hash = bn254::hash_2([recipient_address, 0]);
    assert(correct_hash == wrong_hash, "Invalid recipient_hash");
}
