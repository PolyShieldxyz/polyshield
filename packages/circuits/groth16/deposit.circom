pragma circom 2.1.6;

include "./lib/checks.circom";
include "./lib/note.circom";

// Deposit binding proof (FC-2 / T20).
//
// Binds the hidden note `balance` and `owner_address` inside a deposit
// commitment to the publicly transferred `amount` and `msg.sender`. Without
// this, a depositor could commit a larger balance than they paid and drain the
// shared pool (the committed balance is otherwise unconstrained on-chain).
//
// The Vault calls the verifier with public inputs
// (commitment, amount, uint256(uint160(msg.sender))), forcing:
//   balance == amount, nonce == 0, owner_address == msg.sender.
//
// No Merkle path, no nullifier — this is a single-hash circuit, fast to prove.
template Deposit() {
    signal input secret;        // private

    signal input commitment;    // public
    signal input amount;        // public — USDC (6dp), bound to note balance
    signal input owner_address; // public — uint256(uint160(msg.sender))

    // amount must fit the u64 balance field width used by every note circuit.
    component amountBits = AssertBits(64);
    amountBits.in <== amount;

    // commitment must open to (secret, amount, 0, owner_address).
    component c = NoteCommitment();
    c.secret <== secret;
    c.balance <== amount;
    c.nonce <== 0;
    c.owner_address <== owner_address;
    c.out === commitment;
}

component main {public [commitment, amount, owner_address]} = Deposit();
