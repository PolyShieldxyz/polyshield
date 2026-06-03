pragma circom 2.1.6;

include "./lib/checks.circom";
include "./lib/merkle.circom";
include "./lib/note.circom";

template SettlementCredit() {
    signal input secret;
    signal input balance_before_credit;
    signal input nonce;
    signal input bet_nonce;   // nonce of the note that was spent at bet auth time (private)
    signal input merkle_path[32];
    signal input merkle_path_indices[32];
    signal input owner_address;

    signal input merkle_root;
    signal input nullifier;
    signal input new_commitment;
    signal input nullifier_of_bet;
    signal input market_id;
    // payout_per_share and shares_held removed — Vault injects them on-chain
    signal input total_credit;

    component balanceBits = AssertBits(64);
    balanceBits.in <== balance_before_credit;
    component nonceBits = AssertBits(64);
    nonceBits.in <== nonce;
    component creditBits = AssertBits(64);
    creditBits.in <== total_credit;

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
    new_balance <== balance_before_credit + total_credit;
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

    // SEC-001: constrain bet_nonce so it is no longer a fully free witness. The settlement design
    // intentionally decouples the credited note from the bet receipt — a user may settle an open
    // bet after later activity on the same deposit chain (see SettlementModal.tsx) — so we CANNOT
    // bind bet_nonce == nonce - 1 as the cancel circuits do. Instead require bet_nonce < nonce: the
    // referenced bet must sit at a strictly earlier nonce on the same secret's chain than the note
    // being spent. This holds in every legitimate flow and forces nonce >= 1.
    component betNonceBits = AssertBits(64);
    betNonceBits.in <== bet_nonce;
    component betNonceOrder = AssertLessThan(64);
    betNonceOrder.lhs <== bet_nonce;
    betNonceOrder.rhs <== nonce;

    component preBetNullifier = NullifierHash();
    preBetNullifier.secret <== secret;
    preBetNullifier.nonce <== bet_nonce;
    preBetNullifier.out === nullifier_of_bet;
    // SEC-008: market_id stays public for on-chain binding only; intentionally unconstrained in-circuit.
}

component main {public [merkle_root, nullifier, new_commitment, nullifier_of_bet, market_id, total_credit]} = SettlementCredit();
