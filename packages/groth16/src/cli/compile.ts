import { CIRCUIT_IDS } from "../constants";
import { getCircuitArtifacts } from "../artifacts";
import { ensureDir, setupDirectories, runOrThrow, loadManifest, saveManifest, circuitMetadata } from "./shared";

setupDirectories();

for (const circuitId of CIRCUIT_IDS) {
  const artifacts = getCircuitArtifacts(circuitId);
  ensureDir(artifacts.outputDir);

  runOrThrow("circom", [
    artifacts.circuitPath,
    "--r1cs",
    "--wasm",
    "--sym",
    "-o",
    artifacts.outputDir,
  ]);
}

const manifest = loadManifest();
manifest.generatedAt = new Date().toISOString();
manifest.circuits = Object.fromEntries(
  CIRCUIT_IDS.map((circuitId) => [circuitId, circuitMetadata(circuitId)])
);
saveManifest(manifest);
