import { groth16 } from "snarkjs";

import { getCircuitArtifacts } from "./artifacts";
import type { CircuitId, Groth16Proof, WitnessInputByCircuit } from "./interfaces";
import { serializeGroth16Proof } from "./proof";

export interface GeneratedProofResult {
  proof: Groth16Proof;
  proofBytes: string;
  publicSignals: string[];
}

export async function generateGroth16Proof<C extends CircuitId>(
  circuitId: C,
  witnessInput: WitnessInputByCircuit[C]
): Promise<GeneratedProofResult> {
  const artifacts = getCircuitArtifacts(circuitId);
  const result = await groth16.fullProve(
    witnessInput as unknown as Record<string, unknown>,
    artifacts.wasmPath,
    artifacts.zkeyPath
  );

  const proof = result.proof as Groth16Proof;

  return {
    proof,
    proofBytes: serializeGroth16Proof(proof),
    publicSignals: result.publicSignals,
  };
}
