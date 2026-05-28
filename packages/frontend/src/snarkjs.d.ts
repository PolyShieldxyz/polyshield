declare module 'snarkjs' {
  interface Groth16Proof {
    pi_a: [string, string, string]
    pi_b: [[string, string], [string, string], [string, string]]
    pi_c: [string, string, string]
    protocol: string
    curve: string
  }

  interface ZkeyBuffer {
    type: 'mem'
    data: Uint8Array
  }

  interface WasmBuffer {
    type: 'mem'
    data: Uint8Array
  }

  export const groth16: {
    fullProve(
      input: Record<string, string | string[]>,
      wasmFile: WasmBuffer | string,
      zkeyFile: ZkeyBuffer | string
    ): Promise<{ proof: Groth16Proof; publicSignals: string[] }>
  }
}
