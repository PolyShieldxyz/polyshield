import path from "path";

import {
  ARTIFACTS_DIR,
  CIRCUITS_DIR,
  GENERATED_CONTRACTS_DIR,
  SETUP_DIR,
} from "./constants";
import type { CircuitId, Groth16Artifacts } from "./interfaces";

function pascalCaseCircuitId(circuitId: CircuitId): string {
  return circuitId
    .split("_")
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join("");
}

export function getCircuitArtifacts(circuitId: CircuitId): Groth16Artifacts {
  const outputDir = path.join(ARTIFACTS_DIR, circuitId);
  const baseName = path.join(outputDir, circuitId);

  return {
    circuitId,
    circuitPath: path.join(CIRCUITS_DIR, `${circuitId}.circom`),
    outputDir,
    r1csPath: `${baseName}.r1cs`,
    wasmPath: path.join(outputDir, `${circuitId}_js`, `${circuitId}.wasm`),
    symPath: `${baseName}.sym`,
    zkeyPath: path.join(SETUP_DIR, `${circuitId}.zkey`),
    verificationKeyPath: path.join(outputDir, "verification_key.json"),
    generatedVerifierPath: path.join(
      GENERATED_CONTRACTS_DIR,
      `${pascalCaseCircuitId(circuitId)}Verifier.sol`
    ),
  };
}
