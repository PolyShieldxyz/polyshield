pragma circom 2.1.6;

include "./lib/checks.circom";
include "./lib/merkle.circom";
include "./lib/note.circom";

template CancelCredit() {
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
    signal input market_id;
    signal input bet_amount;

    component balanceBits = AssertBits(64);
    balanceBits.in <== current_balance;
    component nonceBits = AssertBits(64);
    nonceBits.in <== nonce;
    component betAmountBits = AssertBits(64);
    betAmountBits.in <== bet_amount;

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
    restored_balance <== current_balance + bet_amount;
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

    // SEC-002: require nonce >= 1 so `nonce - 1` cannot underflow to the field modulus (p-1).
    component nonceNZ = AssertLessThan(64);
    nonceNZ.lhs <== 0;
    nonceNZ.rhs <== nonce;

    component preBetNullifier = NullifierHash();
    preBetNullifier.secret <== secret;
    preBetNullifier.nonce <== nonce - 1;
    preBetNullifier.out === nullifier_of_bet;
    // SEC-008: market_id stays public for on-chain binding only; intentionally unconstrained in-circuit.
}

component main {public [merkle_root, nullifier, new_commitment, nullifier_of_bet, market_id, bet_amount]} = CancelCredit();
