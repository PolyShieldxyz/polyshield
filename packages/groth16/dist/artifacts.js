"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCircuitArtifacts = getCircuitArtifacts;
const path_1 = __importDefault(require("path"));
const constants_1 = require("./constants");
function pascalCaseCircuitId(circuitId) {
    return circuitId
        .split("_")
        .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
        .join("");
}
function getCircuitArtifacts(circuitId) {
    const outputDir = path_1.default.join(constants_1.ARTIFACTS_DIR, circuitId);
    const baseName = path_1.default.join(outputDir, circuitId);
    return {
        circuitId,
        circuitPath: path_1.default.join(constants_1.CIRCUITS_DIR, `${circuitId}.circom`),
        outputDir,
        r1csPath: `${baseName}.r1cs`,
        wasmPath: path_1.default.join(outputDir, `${circuitId}_js`, `${circuitId}.wasm`),
        symPath: `${baseName}.sym`,
        zkeyPath: path_1.default.join(constants_1.SETUP_DIR, `${circuitId}.zkey`),
        verificationKeyPath: path_1.default.join(outputDir, "verification_key.json"),
        generatedVerifierPath: path_1.default.join(constants_1.GENERATED_CONTRACTS_DIR, `${pascalCaseCircuitId(circuitId)}Verifier.sol`),
    };
}
//# sourceMappingURL=artifacts.js.map