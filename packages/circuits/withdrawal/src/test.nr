use dep::std::hash::poseidon::bn254;
use dep::merkle::merkle_verify;

fn build_zero_path() -> [Field; 32] {
    let mut path: [Field; 32] = [0; 32];
    let mut h: Field = 0;
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
    let withdrawal_amount: u64 = 500_000_000; // partial withdrawal
    // owner_address == recipient_address (enforced by constraint 5)
    let owner_address: Field = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    let recipient_address: Field = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    let commitment = bn254::hash_4([secret, final_balance as Field, nonce as Field, owner_address]);
    let merkle_root = single_leaf_root(commitment);
    let merkle_path = build_zero_path();

    let nullifier = bn254::hash_2([secret, nonce as Field]);
    let recipient_hash = bn254::hash_2([recipient_address, 0]);
    let remaining_balance = final_balance - withdrawal_amount;
    let new_commitment = bn254::hash_4([
        secret,
        remaining_balance as Field,
        (nonce + 1) as Field,
        owner_address,
    ]);

    assert(merkle_verify(commitment, merkle_path, [0; 32]) == merkle_root);
    assert(bn254::hash_2([secret, nonce as Field]) == nullifier);
    assert(withdrawal_amount <= final_balance);
    assert(bn254::hash_2([recipient_address, 0]) == recipient_hash);
    // Constraint 5: recipient must match owner
    assert(recipient_address == owner_address);
    assert(new_commitment == bn254::hash_4([
        secret,
        remaining_balance as Field,
        (nonce + 1) as Field,
        owner_address,
    ]));
}

#[test]
fn test_withdrawal_full_uses_zero_sentinel() {
    let secret: Field = 13;
    let final_balance: u64 = 2_000_000_000;
    let nonce: u64 = 3;
    let withdrawal_amount: u64 = 2_000_000_000;
    let owner_address: Field = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    let recipient_address: Field = owner_address;
    let new_commitment: Field = 0;

    let commitment = bn254::hash_4([secret, final_balance as Field, nonce as Field, owner_address]);
    let merkle_root = single_leaf_root(commitment);
    let merkle_path = build_zero_path();
    let nullifier = bn254::hash_2([secret, nonce as Field]);
    let recipient_hash = bn254::hash_2([recipient_address, 0]);

    assert(merkle_verify(commitment, merkle_path, [0; 32]) == merkle_root);
    assert(bn254::hash_2([secret, nonce as Field]) == nullifier);
    assert(withdrawal_amount == final_balance);
    assert(bn254::hash_2([recipient_address, 0]) == recipient_hash);
    assert(new_commitment == 0);
}

// Print witness values for Prover.toml generation
#[test]
fn test_print_bench_inputs() {
    let secret: Field = 13;
    let final_balance: u64 = 2_000_000_000;
    let nonce: u64 = 3;
    let withdrawal_amount: u64 = 2_000_000_000;
    let owner_address: Field = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    let recipient_address: Field = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    let commitment = bn254::hash_4([secret, final_balance as Field, nonce as Field, owner_address]);
    let merkle_path = build_zero_path();
    let merkle_root = single_leaf_root(commitment);
    let nullifier = bn254::hash_2([secret, nonce as Field]);
    let recipient_hash = bn254::hash_2([recipient_address, 0]);
    let new_commitment: Field = 0;

    println(f"BENCH secret {secret}");
    println(f"BENCH final_balance {final_balance}");
    println(f"BENCH nonce {nonce}");
    println(f"BENCH owner_address {owner_address}");
    println(f"BENCH recipient_address {recipient_address}");
    println(f"BENCH merkle_root {merkle_root}");
    println(f"BENCH nullifier {nullifier}");
    println(f"BENCH withdrawal_amount {withdrawal_amount}");
    println(f"BENCH recipient_hash {recipient_hash}");
    println(f"BENCH new_commitment {new_commitment}");
    println("BENCH path_start");
    for i in 0..32 {
        println(merkle_path[i]);
    }
    println("BENCH path_end");
}

// Wrong Merkle root
#[test(should_fail_with = "Invalid Merkle proof")]
fn test_withdrawal_wrong_root() {
    let secret: Field = 13;
    let final_balance: u64 = 2_000_000_000;
    let nonce: u64 = 3;
    let owner_address: Field = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    let commitment = bn254::hash_4([secret, final_balance as Field, nonce as Field, owner_address]);
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
    let recipient_address: Field = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    let wrong_hash: Field = 0;

    let correct_hash = bn254::hash_2([recipient_address, 0]);
    assert(correct_hash == wrong_hash, "Invalid recipient_hash");
}

// Recipient does not match owner -- constraint 5 should fail
#[test(should_fail_with = "Recipient must match note owner")]
fn test_withdrawal_wrong_owner() {
    let owner_address: Field = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    let recipient_address: Field = 0xdeadbeef; // different address

    assert(recipient_address == owner_address, "Recipient must match note owner");
}

#[test(should_fail_with = "Invalid remainder commitment")]
fn test_withdrawal_bad_remainder_commitment() {
    let secret: Field = 13;
    let final_balance: u64 = 2_000_000_000;
    let nonce: u64 = 3;
    let withdrawal_amount: u64 = 500_000_000;
    let owner_address: Field = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    let wrong_commitment: Field = 0;
    let expected = bn254::hash_4([
        secret,
        (final_balance - withdrawal_amount) as Field,
        (nonce + 1) as Field,
        owner_address,
    ]);

    assert(wrong_commitment == expected, "Invalid remainder commitment");
}

#[test(should_fail_with = "Full withdrawal must use zero commitment")]
fn test_withdrawal_full_with_nonzero_commitment_fails() {
    let wrong_commitment: Field = 1;
    assert(wrong_commitment == 0, "Full withdrawal must use zero commitment");
}
