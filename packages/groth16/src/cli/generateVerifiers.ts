import fs from "fs";

import { CIRCUIT_IDS } from "../constants";
import { getCircuitArtifacts } from "../artifacts";
import {
  assertSnarkjsInstalled,
  circuitMetadata,
  loadManifest,
  localSnarkjsBinary,
  runOrThrow,
  saveManifest,
  setupDirectories,
  sha256File,
} from "./shared";

setupDirectories();
assertSnarkjsInstalled();

const snarkjs = localSnarkjsBinary();
const manifest = loadManifest();
const circuitManifest: Record<string, unknown> = {};

for (const circuitId of CIRCUIT_IDS) {
  const artifacts = getCircuitArtifacts(circuitId);
  runOrThrow(snarkjs, ["zkey", "export", "solidityverifier", artifacts.zkeyPath, artifacts.generatedVerifierPath]);

  circuitManifest[circuitId] = {
    ...circuitMetadata(circuitId),
    hashes: {
      r1cs: fs.existsSync(artifacts.r1csPath) ? sha256File(artifacts.r1csPath) : null,
      wasm: fs.existsSync(artifacts.wasmPath) ? sha256File(artifacts.wasmPath) : null,
      zkey: fs.existsSync(artifacts.zkeyPath) ? sha256File(artifacts.zkeyPath) : null,
      verificationKey: fs.existsSync(artifacts.verificationKeyPath)
        ? sha256File(artifacts.verificationKeyPath)
        : null,
      verifier: fs.existsSync(artifacts.generatedVerifierPath)
        ? sha256File(artifacts.generatedVerifierPath)
        : null,
    },
  };
}

manifest.generatedAt = new Date().toISOString();
manifest.circuits = circuitManifest;
saveManifest(manifest);
