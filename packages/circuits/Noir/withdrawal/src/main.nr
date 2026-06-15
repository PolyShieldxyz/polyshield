use dep::std::hash::poseidon::bn254;
use dep::merkle::merkle_verify;

mod test;

fn main(
    // Private inputs
    secret: Field,
    final_balance: u64,
    nonce: u64,
    merkle_path: [Field; 32],
    merkle_path_indices: [u1; 32],
    owner_address: Field,
    // Actual withdrawal address -- kept private to prevent front-running
    recipient_address: Field,

    // Public inputs
    merkle_root: pub Field,
    nullifier: pub Field,
    withdrawal_amount: pub u64,
    // = poseidon2(recipient_address, 0); binds recipient inside the proof
    recipient_hash: pub Field,
    new_commitment: pub Field,
) {
    // 1. Verify the note is in the Merkle tree
    let commitment = bn254::hash_4([secret, final_balance as Field, nonce as Field, owner_address]);
    let computed_root = merkle_verify(commitment, merkle_path, merkle_path_indices);
    assert(computed_root == merkle_root, "Invalid Merkle proof");

    // 2. Verify the nullifier
    let computed_nullifier = bn254::hash_2([secret, nonce as Field]);
    assert(computed_nullifier == nullifier, "Invalid nullifier");

    // 3. Verify withdrawal amount does not exceed balance
    assert(withdrawal_amount <= final_balance, "Withdrawal exceeds balance");

    // 4. Bind the recipient address inside the proof (prevents MEV front-running).
    //    Domain separator 0 matches Vault.sol's on-chain verification.
    let computed_hash = bn254::hash_2([recipient_address, 0]);
    assert(computed_hash == recipient_hash, "Invalid recipient_hash");

    // 5. Enforce W-to-W: recipient must be the note's owner_address
    // recipient_address == owner_address (both are Field representations of the same wallet address)
    assert(recipient_address == owner_address, "Recipient must match note owner");

    // 6. Bind the post-withdrawal state. Partial withdrawals must recommit the remaining
    // balance into a fresh note; full withdrawals must use the zero sentinel.
    let remaining_balance = final_balance - withdrawal_amount;
    if withdrawal_amount < final_balance {
        let next_commitment = bn254::hash_4([
            secret,
            remaining_balance as Field,
            (nonce + 1) as Field,
            owner_address,
        ]);
        assert(new_commitment == next_commitment, "Invalid remainder commitment");
    } else {
        assert(new_commitment == 0, "Full withdrawal must use zero commitment");
    }
}
