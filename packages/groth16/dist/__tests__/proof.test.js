"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const proof_1 = require("../proof");
describe("Groth16 proof serialization", () => {
    it("round-trips abi encoded proof bytes", () => {
        const encoded = (0, proof_1.serializeGroth16Proof)({
            pi_a: [1n, 2n],
            pi_b: [
                [3n, 4n],
                [5n, 6n],
            ],
            pi_c: [7n, 8n],
        });
        expect((0, proof_1.deserializeGroth16Proof)(encoded)).toEqual({
            a: [1n, 2n],
            b: [
                [3n, 4n],
                [5n, 6n],
            ],
            c: [7n, 8n],
        });
    });
});
//# sourceMappingURL=proof.test.js.map