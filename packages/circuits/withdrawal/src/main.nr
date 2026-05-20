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
    // Actual withdrawal address -- kept private to prevent front-running
    recipient_address: Field,

    // Public inputs
    merkle_root: pub Field,
    nullifier: pub Field,
    withdrawal_amount: pub u64,
    // = poseidon2(recipient_address, 0); binds recipient inside the proof
    recipient_hash: pub Field,
) {
    // 1. Verify the note is in the Merkle tree
    let commitment = bn254::hash_3([secret, final_balance as Field, nonce as Field]);
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
}
