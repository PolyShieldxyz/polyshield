"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const constants_1 = require("../constants");
const artifacts_1 = require("../artifacts");
const shared_1 = require("./shared");
(0, shared_1.setupDirectories)();
(0, shared_1.assertSnarkjsInstalled)();
const snarkjs = (0, shared_1.localSnarkjsBinary)();
const manifest = (0, shared_1.loadManifest)();
const circuitManifest = {};
for (const circuitId of constants_1.CIRCUIT_IDS) {
    const artifacts = (0, artifacts_1.getCircuitArtifacts)(circuitId);
    (0, shared_1.runOrThrow)(snarkjs, ["zkey", "export", "solidityverifier", artifacts.zkeyPath, artifacts.generatedVerifierPath]);
    circuitManifest[circuitId] = {
        ...(0, shared_1.circuitMetadata)(circuitId),
        hashes: {
            r1cs: fs_1.default.existsSync(artifacts.r1csPath) ? (0, shared_1.sha256File)(artifacts.r1csPath) : null,
            wasm: fs_1.default.existsSync(artifacts.wasmPath) ? (0, shared_1.sha256File)(artifacts.wasmPath) : null,
            zkey: fs_1.default.existsSync(artifacts.zkeyPath) ? (0, shared_1.sha256File)(artifacts.zkeyPath) : null,
            verificationKey: fs_1.default.existsSync(artifacts.verificationKeyPath)
                ? (0, shared_1.sha256File)(artifacts.verificationKeyPath)
                : null,
            verifier: fs_1.default.existsSync(artifacts.generatedVerifierPath)
                ? (0, shared_1.sha256File)(artifacts.generatedVerifierPath)
                : null,
        },
    };
}
manifest.generatedAt = new Date().toISOString();
manifest.circuits = circuitManifest;
(0, shared_1.saveManifest)(manifest);
//# sourceMappingURL=generateVerifiers.js.map