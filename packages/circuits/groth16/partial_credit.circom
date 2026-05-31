pragma circom 2.1.6;

include "./lib/checks.circom";
include "./lib/merkle.circom";
include "./lib/note.circom";

// Partial-fill credit (FC-4 native limit orders, GTC/GTD).
//
// Constraint-identical to bet_cancel: the user spends the post-bet note, proves
// membership, and recommits `current_balance + refund_amount`. `refund_amount`
// is the unfilled remainder of a partially-filled limit order
// (bet_amount - spent_amount), Vault-injected on-chain from reportPartialFill
// (the user cannot alter it in the proof). Public-input shape matches bet_cancel.
template PartialCredit() {
    signal input secret;
    signal input current_balance;
    signal input nonce;
    signal input merkle_path[32];
    signal input merkle_path_indices[32];
    signal input owner_address;

    signal input merkle_root;
    signal input nullifier;
    signal input new_commitment;
    signal input nullifier_of_bet;
    // refund_amount injected by the Vault from reportPartialFill (bet_amount - spent_amount)
    signal input refund_amount;

    component balanceBits = AssertBits(64);
    balanceBits.in <== current_balance;
    component nonceBits = AssertBits(64);
    nonceBits.in <== nonce;
    component refundBits = AssertBits(64);
    refundBits.in <== refund_amount;

    component oldCommitment = NoteCommitment();
    oldCommitment.secret <== secret;
    oldCommitment.balance <== current_balance;
    oldCommitment.nonce <== nonce;
    oldCommitment.owner_address <== owner_address;

    component merkle = PoseidonMerklePath(32);
    merkle.leaf <== oldCommitment.out;
    for (var i = 0; i < 32; i++) {
        merkle.siblings[i] <== merkle_path[i];
        merkle.pathIndices[i] <== merkle_path_indices[i];
    }
    merkle.root === merkle_root;

    component spent = NullifierHash();
    spent.secret <== secret;
    spent.nonce <== nonce;
    spent.out === nullifier;

    signal restored_balance;
    restored_balance <== current_balance + refund_amount;
    component restoredBits = AssertBits(64);
    restoredBits.in <== restored_balance;

    component nextNonce = IncrementU64();
    nextNonce.in <== nonce;

    component nextCommitment = NoteCommitment();
    nextCommitment.secret <== secret;
    nextCommitment.balance <== restored_balance;
    nextCommitment.nonce <== nextNonce.out;
    nextCommitment.owner_address <== owner_address;
    nextCommitment.out === new_commitment;

    component preBetNullifier = NullifierHash();
    preBetNullifier.secret <== secret;
    preBetNullifier.nonce <== nonce - 1;
    preBetNullifier.out === nullifier_of_bet;
}

component main {public [merkle_root, nullifier, new_commitment, nullifier_of_bet, refund_amount]} = PartialCredit();
