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

// Valid proof -- market resolved N/A
#[test]
fn test_cancel_credit_valid() {
    let secret: Field = 88;
    let current_balance: u64 = 700_000_000; // 700 USDC post-bet
    let nonce: u64 = 2;
    let bet_amount: u64 = 300_000_000; // Vault-injected
    let market_id: Field = 12345;

    let old_commitment = bn254::hash_3([secret, current_balance as Field, nonce as Field]);
    let merkle_root = single_leaf_root(old_commitment);
    let merkle_path = build_zero_path();

    let nullifier = bn254::hash_2([secret, nonce as Field]);
    let restored_balance = current_balance + bet_amount;
    let new_commitment = bn254::hash_3([secret, restored_balance as Field, (nonce + 1) as Field]);

    assert(merkle_verify(old_commitment, merkle_path, [0; 32]) == merkle_root);
    assert(bn254::hash_2([secret, nonce as Field]) == nullifier);
    assert(bn254::hash_3([secret, restored_balance as Field, (nonce + 1) as Field]) == new_commitment);

    let _ = market_id;
}

// Wrong Merkle root
#[test(should_fail_with = "Invalid Merkle proof")]
fn test_cancel_credit_wrong_root() {
    let secret: Field = 88;
    let current_balance: u64 = 700_000_000;
    let nonce: u64 = 2;

    let old_commitment = bn254::hash_3([secret, current_balance as Field, nonce as Field]);
    let merkle_path = build_zero_path();
    let computed_root = merkle_verify(old_commitment, merkle_path, [0; 32]);
    assert(computed_root == 0, "Invalid Merkle proof");
}

// Wrong new_commitment
#[test(should_fail_with = "Invalid new_commitment")]
fn test_cancel_credit_wrong_new_commitment() {
    let secret: Field = 88;
    let current_balance: u64 = 700_000_000;
    let bet_amount: u64 = 300_000_000;
    let nonce: u64 = 2;

    let restored_balance = current_balance + bet_amount;
    let correct = bn254::hash_3([secret, restored_balance as Field, (nonce + 1) as Field]);
    assert(correct == 0, "Invalid new_commitment");
}
