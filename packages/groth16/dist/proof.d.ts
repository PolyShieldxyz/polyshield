import type { Groth16Proof } from "./interfaces";
export interface DecodedGroth16Proof {
    a: [bigint, bigint];
    b: [[bigint, bigint], [bigint, bigint]];
    c: [bigint, bigint];
}
export declare function serializeGroth16Proof(proof: Groth16Proof): string;
export declare function deserializeGroth16Proof(encoded: string): DecodedGroth16Proof;
//# sourceMappingURL=proof.d.ts.map