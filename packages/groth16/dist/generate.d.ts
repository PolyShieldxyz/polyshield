import type { CircuitId, Groth16Proof, WitnessInputByCircuit } from "./interfaces";
export interface GeneratedProofResult {
    proof: Groth16Proof;
    proofBytes: string;
    publicSignals: string[];
}
export declare function generateGroth16Proof<C extends CircuitId>(circuitId: C, witnessInput: WitnessInputByCircuit[C]): Promise<GeneratedProofResult>;
//# sourceMappingURL=generate.d.ts.map