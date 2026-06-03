pragma circom 2.1.6;

include "./lib/checks.circom";
include "./lib/merkle.circom";
include "./lib/note.circom";

// Position close credit (FC-1).
//
// Mirror of settlement_credit: the user spends their current note, proves
// membership, and recommits `balance + sell_proceeds`. `sell_proceeds` is the
// operator-reported FOK SELL proceeds, Vault-injected on-chain (the user cannot
// alter it in the proof). No `market_id` — closing is not tied to resolution.
template PositionClose() {
    signal input secret;
    signal input balance_before_credit;
    signal input nonce;
    signal input bet_nonce;   // nonce of the note spent at bet auth time (private)
    signal input merkle_path[32];
    signal input merkle_path_indices[32];
    signal input owner_address;

    signal input merkle_root;
    signal input nullifier;
    signal input new_commitment;
    signal input nullifier_of_bet;
    // sell_proceeds injected by the Vault from reportSold
    signal input sell_proceeds;

    component balanceBits = AssertBits(64);
    balanceBits.in <== balance_before_credit;
    component nonceBits = AssertBits(64);
    nonceBits.in <== nonce;
    component proceedsBits = AssertBits(64);
    proceedsBits.in <== sell_proceeds;

    component oldCommitment = NoteCommitment();
    oldCommitment.secret <== secret;
    oldCommitment.balance <== balance_before_credit;
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

    signal new_balance;
    new_balance <== balance_before_credit + sell_proceeds;
    component newBalanceBits = AssertBits(64);
    newBalanceBits.in <== new_balance;

    component nextNonce = IncrementU64();
    nextNonce.in <== nonce;

    component nextCommitment = NoteCommitment();
    nextCommitment.secret <== secret;
    nextCommitment.balance <== new_balance;
    nextCommitment.nonce <== nextNonce.out;
    nextCommitment.owner_address <== owner_address;
    nextCommitment.out === new_commitment;

    // SEC-001: constrain bet_nonce so it is no longer a fully free witness. As with settlement,
    // the close design spends the current free note on the bet's deposit chain (see
    // ClosePositionModal.tsx), which may be several nonces ahead of the bet, so we CANNOT bind
    // bet_nonce == nonce - 1. Instead require bet_nonce < nonce: the referenced bet must sit at a
    // strictly earlier nonce on the same secret's chain. Holds in every legitimate flow; forces nonce >= 1.
    component betNonceBits = AssertBits(64);
    betNonceBits.in <== bet_nonce;
    component betNonceOrder = AssertLessThan(64);
    betNonceOrder.lhs <== bet_nonce;
    betNonceOrder.rhs <== nonce;

    component preBetNullifier = NullifierHash();
    preBetNullifier.secret <== secret;
    preBetNullifier.nonce <== bet_nonce;
    preBetNullifier.out === nullifier_of_bet;
}

component main {public [merkle_root, nullifier, new_commitment, nullifier_of_bet, sell_proceeds]} = PositionClose();
