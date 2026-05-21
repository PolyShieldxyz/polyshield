pragma circom 2.1.6;

include "../../node_modules/circomlib/circuits/poseidon.circom";

template NoteCommitment() {
    signal input secret;
    signal input balance;
    signal input nonce;
    signal output out;

    component hash = Poseidon(3);
    hash.inputs[0] <== secret;
    hash.inputs[1] <== balance;
    hash.inputs[2] <== nonce;

    out <== hash.out;
}

template NullifierHash() {
    signal input secret;
    signal input nonce;
    signal output out;

    component hash = Poseidon(2);
    hash.inputs[0] <== secret;
    hash.inputs[1] <== nonce;

    out <== hash.out;
}

template RecipientHash() {
    signal input recipient;
    signal output out;

    component hash = Poseidon(2);
    hash.inputs[0] <== recipient;
    hash.inputs[1] <== 0;

    out <== hash.out;
}
