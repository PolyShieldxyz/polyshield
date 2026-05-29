pragma circom 2.1.6;

include "../../node_modules/circomlib/circuits/bitify.circom";
include "../../node_modules/circomlib/circuits/comparators.circom";

template AssertBits(n) {
    signal input in;

    component bits = Num2Bits(n);
    bits.in <== in;
}

template AssertBool() {
    signal input in;

    in * (in - 1) === 0;
}

template AssertLessThan(n) {
    signal input lhs;
    signal input rhs;

    component lt = LessThan(n);
    lt.in[0] <== lhs;
    lt.in[1] <== rhs;
    lt.out === 1;
}

template AssertNotLessThan(n) {
    signal input lhs;
    signal input rhs;

    component lt = LessThan(n);
    lt.in[0] <== lhs;
    lt.in[1] <== rhs;
    lt.out === 0;
}

template IncrementU64() {
    signal input in;
    signal output out;

    out <== in + 1;

    component outBits = AssertBits(64);
    outBits.in <== out;
}
