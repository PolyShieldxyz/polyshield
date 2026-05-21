"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateGroth16Proof = generateGroth16Proof;
const snarkjs_1 = require("snarkjs");
const artifacts_1 = require("./artifacts");
const proof_1 = require("./proof");
async function generateGroth16Proof(circuitId, witnessInput) {
    const artifacts = (0, artifacts_1.getCircuitArtifacts)(circuitId);
    const result = await snarkjs_1.groth16.fullProve(witnessInput, artifacts.wasmPath, artifacts.zkeyPath);
    const proof = result.proof;
    return {
        proof,
        proofBytes: (0, proof_1.serializeGroth16Proof)(proof),
        publicSignals: result.publicSignals,
    };
}
//# sourceMappingURL=generate.js.map