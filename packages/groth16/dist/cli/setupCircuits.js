"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const path_1 = __importDefault(require("path"));
const constants_1 = require("../constants");
const artifacts_1 = require("../artifacts");
const shared_1 = require("./shared");
(0, shared_1.setupDirectories)();
(0, shared_1.assertSnarkjsInstalled)();
const snarkjs = (0, shared_1.localSnarkjsBinary)();
const ptauPath = path_1.default.join(constants_1.SETUP_DIR, "powersOfTau28_hez_dev_final.ptau");
for (const circuitId of constants_1.CIRCUIT_IDS) {
    const artifacts = (0, artifacts_1.getCircuitArtifacts)(circuitId);
    const zkeyIntermediate = path_1.default.join(constants_1.SETUP_DIR, `${circuitId}_0000.zkey`);
    (0, shared_1.runOrThrow)(snarkjs, ["groth16", "setup", artifacts.r1csPath, ptauPath, zkeyIntermediate]);
    (0, shared_1.runOrThrow)(snarkjs, ["zkey", "contribute", zkeyIntermediate, artifacts.zkeyPath, "--name=polyshield-dev", "-e=polyshield-dev-entropy"]);
    (0, shared_1.runOrThrow)(snarkjs, ["zkey", "export", "verificationkey", artifacts.zkeyPath, artifacts.verificationKeyPath]);
}
const manifest = (0, shared_1.loadManifest)();
manifest.generatedAt = new Date().toISOString();
manifest.circuits = Object.fromEntries(constants_1.CIRCUIT_IDS.map((circuitId) => [circuitId, (0, shared_1.circuitMetadata)(circuitId)]));
(0, shared_1.saveManifest)(manifest);
//# sourceMappingURL=setupCircuits.js.map