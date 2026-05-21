"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureDir = ensureDir;
exports.sha256File = sha256File;
exports.runOrThrow = runOrThrow;
exports.manifestPath = manifestPath;
exports.loadManifest = loadManifest;
exports.saveManifest = saveManifest;
exports.assertSnarkjsInstalled = assertSnarkjsInstalled;
exports.localSnarkjsBinary = localSnarkjsBinary;
exports.setupDirectories = setupDirectories;
exports.circuitMetadata = circuitMetadata;
const crypto_1 = require("crypto");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const constants_1 = require("../constants");
const artifacts_1 = require("../artifacts");
function ensureDir(dir) {
    fs_1.default.mkdirSync(dir, { recursive: true });
}
function sha256File(filePath) {
    const contents = fs_1.default.readFileSync(filePath);
    return (0, crypto_1.createHash)("sha256").update(contents).digest("hex");
}
function runOrThrow(bin, args, cwd = constants_1.PACKAGE_ROOT) {
    const result = (0, child_process_1.spawnSync)(bin, args, { cwd, encoding: "utf8" });
    if (result.status !== 0) {
        throw new Error(`${bin} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    }
}
function manifestPath() {
    return path_1.default.join(constants_1.ARTIFACTS_DIR, "manifest.json");
}
function loadManifest() {
    return JSON.parse(fs_1.default.readFileSync(manifestPath(), "utf8"));
}
function saveManifest(manifest) {
    fs_1.default.writeFileSync(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`);
}
function assertSnarkjsInstalled() {
    const localBinary = path_1.default.join(constants_1.PACKAGE_ROOT, "node_modules", ".bin", process.platform === "win32" ? "snarkjs.cmd" : "snarkjs");
    if (!fs_1.default.existsSync(localBinary)) {
        throw new Error("snarkjs is not installed in packages/groth16. Run `npm install` in that package first.");
    }
}
function localSnarkjsBinary() {
    return path_1.default.join(constants_1.PACKAGE_ROOT, "node_modules", ".bin", process.platform === "win32" ? "snarkjs.cmd" : "snarkjs");
}
function setupDirectories() {
    ensureDir(constants_1.ARTIFACTS_DIR);
    ensureDir(constants_1.SETUP_DIR);
    ensureDir(constants_1.GENERATED_CONTRACTS_DIR);
    for (const circuitId of constants_1.CIRCUIT_IDS) {
        ensureDir((0, artifacts_1.getCircuitArtifacts)(circuitId).outputDir);
    }
}
function circuitMetadata(circuitId) {
    const artifacts = (0, artifacts_1.getCircuitArtifacts)(circuitId);
    return {
        circuitPath: path_1.default.relative(constants_1.PACKAGE_ROOT, artifacts.circuitPath),
        r1csPath: path_1.default.relative(constants_1.PACKAGE_ROOT, artifacts.r1csPath),
        wasmPath: path_1.default.relative(constants_1.PACKAGE_ROOT, artifacts.wasmPath),
        symPath: path_1.default.relative(constants_1.PACKAGE_ROOT, artifacts.symPath),
        zkeyPath: path_1.default.relative(constants_1.PACKAGE_ROOT, artifacts.zkeyPath),
        verificationKeyPath: path_1.default.relative(constants_1.PACKAGE_ROOT, artifacts.verificationKeyPath),
        generatedVerifierPath: path_1.default.relative(constants_1.PACKAGE_ROOT, artifacts.generatedVerifierPath),
    };
}
//# sourceMappingURL=shared.js.map