pragma circom 2.1.6;

include "./lib/checks.circom";
include "./lib/constants.circom";
include "./lib/merkle.circom";
include "./lib/note.circom";

template BetAuth() {
    signal input secret;
    signal input current_balance;
    signal input nonce;
    signal input merkle_path[32];
    signal input merkle_path_indices[32];
    signal input share_remainder;

    signal input merkle_root;
    signal input nullifier;
    signal input new_commitment;
    signal input bet_amount;
    signal input price;
    signal input expected_shares;
    signal input market_id;
    signal input outcome_side;
    signal input position_id;

    component currentBalanceBits = AssertBits(64);
    currentBalanceBits.in <== current_balance;
    component nonceBits = AssertBits(64);
    nonceBits.in <== nonce;
    component betAmountBits = AssertBits(64);
    betAmountBits.in <== bet_amount;
    component priceBits = AssertBits(64);
    priceBits.in <== price;
    component expectedSharesBits = AssertBits(64);
    expectedSharesBits.in <== expected_shares;
    component remainderBits = AssertBits(64);
    remainderBits.in <== share_remainder;
    component outcomeSideBits = AssertBits(8);
    outcomeSideBits.in <== outcome_side;

    component oldCommitment = NoteCommitment();
    oldCommitment.secret <== secret;
    oldCommitment.balance <== current_balance;
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

    component balanceCheck = AssertNotLessThan(64);
    balanceCheck.lhs <== current_balance;
    balanceCheck.rhs <== bet_amount;

    component remainderCheck = AssertLessThan(64);
    remainderCheck.lhs <== share_remainder;
    remainderCheck.rhs <== price;

    component constants = Groth16Constants();
    signal scaled_amount;
    signal computed_shares;
    signal lhs;

    scaled_amount <== bet_amount * constants.price_precision;
    computed_shares <== expected_shares * price;
    lhs <== computed_shares + share_remainder;
    lhs === scaled_amount;

    signal new_balance;
    new_balance <== current_balance - bet_amount;
    component newBalanceBits = AssertBits(64);
    newBalanceBits.in <== new_balance;

    component nextNonce = IncrementU64();
    nextNonce.in <== nonce;

    component nextCommitment = NoteCommitment();
    nextCommitment.secret <== secret;
    nextCommitment.balance <== new_balance;
    nextCommitment.nonce <== nextNonce.out;
    nextCommitment.out === new_commitment;

    market_id === market_id;
    position_id === position_id;
}

component main {public [merkle_root, nullifier, new_commitment, bet_amount, price, expected_shares, market_id, outcome_side, position_id]} = BetAuth();
