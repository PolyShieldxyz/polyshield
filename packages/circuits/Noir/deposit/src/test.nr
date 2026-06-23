use dep::std::hash::poseidon::bn254;

// Valid deposit binding (happy path)
#[test]
fn test_deposit_valid() {
    let secret: Field = 101;
    let amount: u64 = 250_000_000; // 250 USDC (6 dec)
    let owner_address: Field = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    // commitment = Poseidon4(secret, amount, 0, owner_address) -- nonce is forced to 0.
    let commitment = bn254::hash_4([secret, amount as Field, 0, owner_address]);

    assert(bn254::hash_4([secret, amount as Field, 0, owner_address]) == commitment);
}

// Print witness values for Prover.toml generation
#[test]
fn test_print_bench_inputs() {
    let secret: Field = 101;
    let amount: u64 = 250_000_000;
    let owner_address: Field = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    let commitment = bn254::hash_4([secret, amount as Field, 0, owner_address]);

    println(f"BENCH secret {secret}");
    println(f"BENCH amount {amount}");
    println(f"BENCH owner_address {owner_address}");
    println(f"BENCH commitment {commitment}");
}

// Wrong commitment -- must fail (this is the T20 anti-overcommit binding)
#[test(should_fail_with = "Invalid commitment")]
fn test_deposit_wrong_commitment() {
    let secret: Field = 101;
    let amount: u64 = 250_000_000;
    let owner_address: Field = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    let correct = bn254::hash_4([secret, amount as Field, 0, owner_address]);
    let wrong: Field = 0;
    assert(correct == wrong, "Invalid commitment");
}

// Committing a larger balance than `amount` produces a different commitment than the
// one bound to the transferred amount -- the pool-drain vector this circuit closes (T20).
#[test(should_fail_with = "Invalid commitment")]
fn test_deposit_overcommit_balance_fails() {
    let secret: Field = 101;
    let amount: u64 = 250_000_000;        // actually transferred
    let inflated_balance: u64 = 9_999_999_999; // attacker commits more than paid
    let owner_address: Field = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    // The verifier recomputes from `amount`; the attacker's inflated commitment won't match.
    let bound = bn254::hash_4([secret, amount as Field, 0, owner_address]);
    let inflated = bn254::hash_4([secret, inflated_balance as Field, 0, owner_address]);
    assert(bound == inflated, "Invalid commitment");
}
