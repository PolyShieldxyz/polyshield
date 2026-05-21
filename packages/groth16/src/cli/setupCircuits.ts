import path from "path";

import { CIRCUIT_IDS, SETUP_DIR } from "../constants";
import { getCircuitArtifacts } from "../artifacts";
import {
  assertSnarkjsInstalled,
  circuitMetadata,
  loadManifest,
  localSnarkjsBinary,
  runOrThrow,
  saveManifest,
  setupDirectories,
} from "./shared";

setupDirectories();
assertSnarkjsInstalled();

const snarkjs = localSnarkjsBinary();
const ptauPath = path.join(SETUP_DIR, "powersOfTau28_hez_dev_final.ptau");

for (const circuitId of CIRCUIT_IDS) {
  const artifacts = getCircuitArtifacts(circuitId);
  const zkeyIntermediate = path.join(SETUP_DIR, `${circuitId}_0000.zkey`);

  runOrThrow(snarkjs, ["groth16", "setup", artifacts.r1csPath, ptauPath, zkeyIntermediate]);
  runOrThrow(snarkjs, ["zkey", "contribute", zkeyIntermediate, artifacts.zkeyPath, "--name=polyshield-dev", "-e=polyshield-dev-entropy"]);
  runOrThrow(snarkjs, ["zkey", "export", "verificationkey", artifacts.zkeyPath, artifacts.verificationKeyPath]);
}

const manifest = loadManifest();
manifest.generatedAt = new Date().toISOString();
manifest.circuits = Object.fromEntries(
  CIRCUIT_IDS.map((circuitId) => [circuitId, circuitMetadata(circuitId)])
);
saveManifest(manifest);
