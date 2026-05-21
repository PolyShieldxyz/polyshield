pragma circom 2.1.6;

include "./lib/checks.circom";
include "./lib/merkle.circom";
include "./lib/note.circom";

template Withdrawal() {
    signal input secret;
    signal input final_balance;
    signal input nonce;
    signal input merkle_path[32];
    signal input merkle_path_indices[32];
    signal input recipient_address;

    signal input merkle_root;
    signal input nullifier;
    signal input withdrawal_amount;
    signal input recipient_hash;

    component balanceBits = AssertBits(64);
    balanceBits.in <== final_balance;
    component nonceBits = AssertBits(64);
    nonceBits.in <== nonce;
    component withdrawalBits = AssertBits(64);
    withdrawalBits.in <== withdrawal_amount;

    component oldCommitment = NoteCommitment();
    oldCommitment.secret <== secret;
    oldCommitment.balance <== final_balance;
    oldCommitment.nonce <== nonce;

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

    component amountCheck = AssertNotLessThan(64);
    amountCheck.lhs <== final_balance;
    amountCheck.rhs <== withdrawal_amount;

    component recipient = RecipientHash();
    recipient.recipient <== recipient_address;
    recipient.out === recipient_hash;
}

component main {public [merkle_root, nullifier, withdrawal_amount, recipient_hash]} = Withdrawal();
