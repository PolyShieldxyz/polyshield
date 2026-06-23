// snarkjs ships no type declarations. Only the surface we use is declared here.
declare module "snarkjs" {
  export const zKey: {
    newZKey(r1csName: string, ptauName: string, zkeyName: string, logger?: unknown): Promise<unknown>;
    contribute(
      oldZkey: string,
      newZkey: string,
      name: string,
      entropy: string,
      logger?: unknown
    ): Promise<unknown>;
    exportVerificationKey(zkeyName: string, logger?: unknown): Promise<unknown>;
    exportSolidityVerifier(
      zkeyName: string,
      templates: { groth16?: string; plonk?: string; fflonk?: string },
      logger?: unknown
    ): Promise<string>;
  };
  export const groth16: {
    fullProve(
      input: Record<string, unknown>,
      wasmFile: string,
      zkeyFile: string,
      logger?: unknown
    ): Promise<{ proof: any; publicSignals: string[] }>;
  };
}
