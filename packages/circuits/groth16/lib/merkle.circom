pragma circom 2.1.6;

include "../../node_modules/circomlib/circuits/poseidon.circom";
include "./checks.circom";

template PoseidonMerklePath(depth) {
    signal input leaf;
    signal input siblings[depth];
    signal input pathIndices[depth];
    signal output root;

    signal hashes[depth + 1];
    signal lefts[depth];
    signal rights[depth];
    hashes[0] <== leaf;

    component bools[depth];
    component hashers[depth];

    for (var i = 0; i < depth; i++) {
        bools[i] = AssertBool();
        bools[i].in <== pathIndices[i];

        lefts[i] <== hashes[i] + pathIndices[i] * (siblings[i] - hashes[i]);
        rights[i] <== siblings[i] + pathIndices[i] * (hashes[i] - siblings[i]);

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== lefts[i];
        hashers[i].inputs[1] <== rights[i];

        hashes[i + 1] <== hashers[i].out;
    }

    root <== hashes[depth];
}
