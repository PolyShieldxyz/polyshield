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
    signal input owner_address;

    signal input merkle_root;
    signal input nullifier;
    signal input new_commitment;
    signal input bet_amount;
    signal input price;
    signal input expected_shares;
    signal input market_id;
    signal input outcome_side;
    signal input position_id;
    // FEE (P2): Vault-injected protocol fee + relay-gas reimbursement, in USDC (6dp).
    // The Vault computes fee = bet_amount * betFeeBps / 10000 + relayGasFeeUSDC from its
    // own governance storage and passes it here as a public input, so a user cannot forge
    // a proof with a different fee: their new_commitment would not match the Vault-injected
    // fee and verification fails. This is identical to the way bet_amount is injected for
    // cancellations. See docs/zk-design.md and CLAUDE.md (Fee model).
    signal input fee;

    component currentBalanceBits = AssertBits(64);
    currentBalanceBits.in <== current_balance;
    component nonceBits = AssertBits(64);
    nonceBits.in <== nonce;
    component betAmountBits = AssertBits(64);
    betAmountBits.in <== bet_amount;
    component feeBits = AssertBits(64);
    feeBits.in <== fee;
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

    component balanceCheck = AssertNotLessThan(64);
    balanceCheck.lhs <== current_balance;
    balanceCheck.rhs <== bet_amount;

    component remainderCheck = AssertLessThan(64);
    remainderCheck.lhs <== share_remainder;
    remainderCheck.rhs <== price;

    // SEC-003: explicitly require price > 0 rather than relying on the emergent
    // `share_remainder < price` bound to reject a zero price.
    component priceNZ = AssertLessThan(64);
    priceNZ.lhs <== 0;
    priceNZ.rhs <== price;

    component constants = Groth16Constants();
    signal scaled_amount;
    signal computed_shares;
    signal lhs;

    scaled_amount <== bet_amount * constants.price_precision;
    computed_shares <== expected_shares * price;
    lhs <== computed_shares + share_remainder;
    lhs === scaled_amount;

    // FEE: deduct the Vault-injected fee in addition to the bet amount. The AssertBits(64)
    // below also enforces current_balance >= bet_amount + fee (an underflow would wrap to a
    // value outside the 64-bit range and fail the range check).
    signal new_balance;
    new_balance <== current_balance - bet_amount - fee;
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

    // SEC-008: market_id and position_id stay public for on-chain binding only; they are
    // intentionally unconstrained in-circuit (the Vault binds them on-chain). No tautology.
}

component main {public [merkle_root, nullifier, new_commitment, bet_amount, price, expected_shares, market_id, outcome_side, position_id, fee]} = BetAuth();
