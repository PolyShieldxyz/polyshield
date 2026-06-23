use dep::std::hash::poseidon::bn254;

mod test;

// Deposit binding proof (Groth16 slot 5, FC-2 / T20). MANDATORY.
//
// Mirrors groth16/deposit.circom. Binds the hidden note `balance` and
// `owner_address` inside a deposit commitment to the publicly transferred `amount`
// and `msg.sender`. Without this, a depositor could commit a larger balance than
// they paid and drain the shared pool (the committed balance is otherwise
// unconstrained on-chain).
//
// The Vault calls the verifier with public inputs
// (commitment, amount, uint256(uint160(msg.sender))), forcing:
//   balance == amount, nonce == 0, owner_address == msg.sender.
//
// No Merkle path, no nullifier — a single-hash circuit, fast to prove.
fn main(
    // Private input
    secret: Field,

    // Public inputs
    commitment: pub Field,
    amount: pub u64,          // USDC (6dp), bound to the note balance
    owner_address: pub Field, // uint256(uint160(msg.sender))
) {
    // `amount` is u64, so it already fits the balance field width used by every note circuit
    // (the Circom version range-checks it with AssertBits(64); the Noir type does this for us).
    //
    // commitment must open to (secret, amount, 0, owner_address).
    let computed_commitment = bn254::hash_4([secret, amount as Field, 0, owner_address]);
    assert(computed_commitment == commitment, "Invalid commitment");
}
