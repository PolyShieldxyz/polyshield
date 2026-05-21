"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const constants_1 = require("../constants");
const artifacts_1 = require("../artifacts");
const shared_1 = require("./shared");
(0, shared_1.setupDirectories)();
for (const circuitId of constants_1.CIRCUIT_IDS) {
    const artifacts = (0, artifacts_1.getCircuitArtifacts)(circuitId);
    (0, shared_1.ensureDir)(artifacts.outputDir);
    (0, shared_1.runOrThrow)("circom", [
        artifacts.circuitPath,
        "--r1cs",
        "--wasm",
        "--sym",
        "-o",
        artifacts.outputDir,
    ]);
}
const manifest = (0, shared_1.loadManifest)();
manifest.generatedAt = new Date().toISOString();
manifest.circuits = Object.fromEntries(constants_1.CIRCUIT_IDS.map((circuitId) => [circuitId, (0, shared_1.circuitMetadata)(circuitId)]));
(0, shared_1.saveManifest)(manifest);
//# sourceMappingURL=compile.js.map