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
    signal input owner_address;
    signal input recipient_address;

    signal input merkle_root;
    signal input nullifier;
    signal input withdrawal_amount;
    signal input recipient_hash;
    signal input new_commitment;

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

    // withdrawal_amount <= final_balance
    component amountCheck = AssertNotLessThan(64);
    amountCheck.lhs <== final_balance;
    amountCheck.rhs <== withdrawal_amount;

    // Bind recipient address inside the proof (prevents front-running)
    component recipient = RecipientHash();
    recipient.recipient <== recipient_address;
    recipient.out === recipient_hash;

    // W-to-W: recipient must be the note owner
    recipient_address === owner_address;

    // Partial withdrawal: new_commitment = hash4(secret, remaining, nonce+1, owner_address)
    // Full withdrawal:    new_commitment = 0
    // Use conditional selector: expected = isPartial * partialHash
    signal remaining_balance;
    remaining_balance <== final_balance - withdrawal_amount;

    component isPartial = LessThan(64);
    isPartial.in[0] <== withdrawal_amount;
    isPartial.in[1] <== final_balance;

    component nextNonce = IncrementU64();
    nextNonce.in <== nonce;

    component partialCommit = NoteCommitment();
    partialCommit.secret <== secret;
    partialCommit.balance <== remaining_balance;
    partialCommit.nonce <== nextNonce.out;
    partialCommit.owner_address <== owner_address;

    // isPartial=1 → new_commitment = partialCommit.out
    // isPartial=0 → new_commitment = 0
    signal expected_new_commitment;
    expected_new_commitment <== isPartial.out * partialCommit.out;
    expected_new_commitment === new_commitment;
}

component main {public [merkle_root, nullifier, withdrawal_amount, recipient_hash, new_commitment]} = Withdrawal();
