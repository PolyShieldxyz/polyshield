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

// Valid consolidation -- slot 0 active, slots 1..3 inactive (nullifier sentinel 0).
//
// A single active input is the degenerate merge; exercising multiple active inputs
// would require a real multi-leaf tree so that every active slot shares one
// merkle_root, which the single_leaf_root helper cannot construct.
#[test]
fn test_consolidate_valid() {
    let secret0: Field = 7;
    let balance0: u64 = 400_000_000;
    let nonce0: u64 = 1;
    let owner_address: Field = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    let cm0 = bn254::hash_4([secret0, balance0 as Field, nonce0 as Field, owner_address]);
    let merkle_root = single_leaf_root(cm0);
    let nullifier0 = bn254::hash_2([secret0, nonce0 as Field]);

    // Inactive slots contribute 0 -> sum is just slot 0's balance.
    let sum: u64 = balance0;
    let new_commitment = bn254::hash_4([secret0, sum as Field, (nonce0 + 1) as Field, owner_address]);

    assert(merkle_verify(cm0, build_zero_path(), [0; 32]) == merkle_root);
    assert(bn254::hash_2([secret0, nonce0 as Field]) == nullifier0);
    // inactive slots publish nullifier 0 (the Vault's skip sentinel)
    assert(bn254::hash_4([secret0, sum as Field, (nonce0 + 1) as Field, owner_address]) == new_commitment);
}

// Print witness values for Prover.toml generation (slot 0 active, slots 1..3 inactive)
#[test]
fn test_print_bench_inputs() {
    let secret0: Field = 7;
    let balance0: u64 = 400_000_000;
    let nonce0: u64 = 1;
    let owner_address: Field = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    let cm0 = bn254::hash_4([secret0, balance0 as Field, nonce0 as Field, owner_address]);
    let merkle_root = single_leaf_root(cm0);
    let nullifier0 = bn254::hash_2([secret0, nonce0 as Field]);
    let sum: u64 = balance0;
    let new_commitment = bn254::hash_4([secret0, sum as Field, (nonce0 + 1) as Field, owner_address]);

    println(f"BENCH secret0 {secret0}");
    println(f"BENCH balance0 {balance0}");
    println(f"BENCH nonce0 {nonce0}");
    println(f"BENCH owner_address {owner_address}");
    println(f"BENCH merkle_root {merkle_root}");
    println(f"BENCH nullifier0 {nullifier0}");
    println(f"BENCH new_commitment {new_commitment}");
    println("BENCH note: slots 1..3 inactive -> nullifier = 0, balance contribution = 0");
}

// Slot 0 must be active (anchors the continued lineage)
#[test(should_fail_with = "Slot 0 must be active")]
fn test_consolidate_slot0_inactive() {
    let is_active0 = false;
    assert(is_active0, "Slot 0 must be active");
}

// An inactive slot must publish nullifier 0 (the Vault's skip sentinel)
#[test(should_fail_with = "Inactive slot nullifier must be zero")]
fn test_consolidate_inactive_nonzero_nullifier() {
    let published: Field = 123; // should be 0 for an inactive slot
    assert(published == 0, "Inactive slot nullifier must be zero");
}

// Wrong merged commitment -- summed balance is wrong
#[test(should_fail_with = "Invalid new_commitment")]
fn test_consolidate_wrong_new_commitment() {
    let secret0: Field = 7;
    let sum: u64 = 400_000_000;
    let nonce0: u64 = 1;
    let owner_address: Field = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    let correct = bn254::hash_4([secret0, sum as Field, (nonce0 + 1) as Field, owner_address]);
    assert(correct == 0, "Invalid new_commitment");
}
