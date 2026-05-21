pragma circom 2.1.6;

template Groth16Constants() {
    signal output price_precision;
    signal output zero;

    price_precision <== 100000000;
    zero <== 0;
}
