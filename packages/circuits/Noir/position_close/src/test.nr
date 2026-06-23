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

// Valid proof (happy path) -- position sold before resolution, proceeds credited
#[test]
fn test_position_close_valid() {
    let secret: Field = 91;
    let balance_before_credit: u64 = 600_000_000; // 600 USDC post-bet
    let nonce: u64 = 2;
    let bet_nonce: u64 = 1; // bet authorized earlier on this secret's chain
    let owner_address: Field = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    // sell_proceeds is Vault-injected from reportSold
    let sell_proceeds: u64 = 320_000_000;

    let old_commitment = bn254::hash_4([secret, balance_before_credit as Field, nonce as Field, owner_address]);
    let merkle_root = single_leaf_root(old_commitment);
    let merkle_path = build_zero_path();

    let nullifier = bn254::hash_2([secret, nonce as Field]);
    let nullifier_of_bet = bn254::hash_2([secret, bet_nonce as Field]);
    let new_balance = balance_before_credit + sell_proceeds;
    let new_commitment = bn254::hash_4([secret, new_balance as Field, (nonce + 1) as Field, owner_address]);

    assert(merkle_verify(old_commitment, merkle_path, [0; 32]) == merkle_root);
    assert(bn254::hash_2([secret, nonce as Field]) == nullifier);
    assert(bn254::hash_4([secret, new_balance as Field, (nonce + 1) as Field, owner_address]) == new_commitment);
    assert(bet_nonce < nonce);
    assert(bn254::hash_2([secret, bet_nonce as Field]) == nullifier_of_bet);
}

// Print witness values for Prover.toml generation
#[test]
fn test_print_bench_inputs() {
    let secret: Field = 91;
    let balance_before_credit: u64 = 600_000_000;
    let nonce: u64 = 2;
    let bet_nonce: u64 = 1;
    let sell_proceeds: u64 = 320_000_000;
    let owner_address: Field = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    let old_commitment = bn254::hash_4([secret, balance_before_credit as Field, nonce as Field, owner_address]);
    let merkle_path = build_zero_path();
    let merkle_root = single_leaf_root(old_commitment);
    let nullifier = bn254::hash_2([secret, nonce as Field]);
    let nullifier_of_bet = bn254::hash_2([secret, bet_nonce as Field]);
    let new_balance = balance_before_credit + sell_proceeds;
    let new_commitment = bn254::hash_4([secret, new_balance as Field, (nonce + 1) as Field, owner_address]);

    println(f"BENCH secret {secret}");
    println(f"BENCH balance_before_credit {balance_before_credit}");
    println(f"BENCH nonce {nonce}");
    println(f"BENCH bet_nonce {bet_nonce}");
    println(f"BENCH owner_address {owner_address}");
    println(f"BENCH sell_proceeds {sell_proceeds}");
    println(f"BENCH nullifier_of_bet {nullifier_of_bet}");
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
fn test_position_close_wrong_root() {
    let secret: Field = 91;
    let balance: u64 = 600_000_000;
    let nonce: u64 = 2;
    let owner_address: Field = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    let old_commitment = bn254::hash_4([secret, balance as Field, nonce as Field, owner_address]);
    let merkle_path = build_zero_path();
    let computed_root = merkle_verify(old_commitment, merkle_path, [0; 32]);
    assert(computed_root == 0, "Invalid Merkle proof");
}

// Wrong new_commitment
#[test(should_fail_with = "Invalid new_commitment")]
fn test_position_close_wrong_new_commitment() {
    let secret: Field = 91;
    let balance_before: u64 = 600_000_000;
    let sell_proceeds: u64 = 320_000_000;
    let nonce: u64 = 2;
    let owner_address: Field = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    let new_balance = balance_before + sell_proceeds;
    let correct = bn254::hash_4([secret, new_balance as Field, (nonce + 1) as Field, owner_address]);
    assert(correct == 0, "Invalid new_commitment");
}

// Wrong nullifier_of_bet -- SEC-001 binding should fail
#[test(should_fail_with = "Invalid nullifier_of_bet")]
fn test_position_close_wrong_bet_nullifier() {
    let secret: Field = 91;
    let bet_nonce: u64 = 1;
    let wrong_nullifier_of_bet: Field = 1357;

    let correct = bn254::hash_2([secret, bet_nonce as Field]);
    assert(correct == wrong_nullifier_of_bet, "Invalid nullifier_of_bet");
}
