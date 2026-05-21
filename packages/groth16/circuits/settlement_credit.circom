pragma circom 2.1.6;

include "./lib/checks.circom";
include "./lib/merkle.circom";
include "./lib/note.circom";

template SettlementCredit() {
    signal input secret;
    signal input balance_before_credit;
    signal input nonce;
    signal input merkle_path[32];
    signal input merkle_path_indices[32];

    signal input merkle_root;
    signal input nullifier;
    signal input new_commitment;
    signal input nullifier_of_bet;
    signal input market_id;
    signal input payout_per_share;
    signal input shares_held;
    signal input total_credit;

    component balanceBits = AssertBits(64);
    balanceBits.in <== balance_before_credit;
    component nonceBits = AssertBits(64);
    nonceBits.in <== nonce;
    component payoutBits = AssertBits(64);
    payoutBits.in <== payout_per_share;
    component sharesBits = AssertBits(64);
    sharesBits.in <== shares_held;
    component creditBits = AssertBits(64);
    creditBits.in <== total_credit;

    component oldCommitment = NoteCommitment();
    oldCommitment.secret <== secret;
    oldCommitment.balance <== balance_before_credit;
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

    signal computed_credit;
    computed_credit <== shares_held * payout_per_share;
    computed_credit === total_credit;

    signal new_balance;
    new_balance <== balance_before_credit + total_credit;
    component newBalanceBits = AssertBits(64);
    newBalanceBits.in <== new_balance;

    component nextNonce = IncrementU64();
    nextNonce.in <== nonce;

    component nextCommitment = NoteCommitment();
    nextCommitment.secret <== secret;
    nextCommitment.balance <== new_balance;
    nextCommitment.nonce <== nextNonce.out;
    nextCommitment.out === new_commitment;

    nullifier_of_bet === nullifier_of_bet;
    market_id === market_id;
}

component main {public [merkle_root, nullifier, new_commitment, nullifier_of_bet, market_id, payout_per_share, shares_held, total_credit]} = SettlementCredit();
