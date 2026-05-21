"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.serializeGroth16Proof = serializeGroth16Proof;
exports.deserializeGroth16Proof = deserializeGroth16Proof;
const ethers_1 = require("ethers");
const publicInputs_1 = require("./publicInputs");
const coder = ethers_1.AbiCoder.defaultAbiCoder();
function serializeGroth16Proof(proof) {
    const a = [(0, publicInputs_1.toBigInt)(proof.pi_a[0]), (0, publicInputs_1.toBigInt)(proof.pi_a[1])];
    const b = [
        [(0, publicInputs_1.toBigInt)(proof.pi_b[0][0]), (0, publicInputs_1.toBigInt)(proof.pi_b[0][1])],
        [(0, publicInputs_1.toBigInt)(proof.pi_b[1][0]), (0, publicInputs_1.toBigInt)(proof.pi_b[1][1])],
    ];
    const c = [(0, publicInputs_1.toBigInt)(proof.pi_c[0]), (0, publicInputs_1.toBigInt)(proof.pi_c[1])];
    return coder.encode(["uint256[2]", "uint256[2][2]", "uint256[2]"], [a, b, c]);
}
function deserializeGroth16Proof(encoded) {
    const [a, b, c] = coder.decode(["uint256[2]", "uint256[2][2]", "uint256[2]"], encoded);
    return {
        a: [(0, publicInputs_1.toBigInt)(a[0]), (0, publicInputs_1.toBigInt)(a[1])],
        b: [
            [(0, publicInputs_1.toBigInt)(b[0][0]), (0, publicInputs_1.toBigInt)(b[0][1])],
            [(0, publicInputs_1.toBigInt)(b[1][0]), (0, publicInputs_1.toBigInt)(b[1][1])],
        ],
        c: [(0, publicInputs_1.toBigInt)(c[0]), (0, publicInputs_1.toBigInt)(c[1])],
    };
}
//# sourceMappingURL=proof.js.map