import { AbiCoder } from "ethers";

// Encodes a snarkjs Groth16 proof into the 256-byte ABI layout the IVerifier
// adapter decodes: abi.encode(uint256[2] pA, uint256[2][2] pB, uint256[2] pC).
//
// The G2 coordinate pairs (pB) are SWAPPED relative to snarkjs ordering to match
// the EIP-197 BN254 precompile convention — identical to the frontend prover's
// encoding. Keep these in lockstep; a mismatch makes valid proofs fail on-chain.
export interface SnarkjsProof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
}

export function encodeProof(proof: SnarkjsProof): string {
  const pA: [string, string] = [proof.pi_a[0], proof.pi_a[1]];
  const pB: [[string, string], [string, string]] = [
    [proof.pi_b[0][1], proof.pi_b[0][0]],
    [proof.pi_b[1][1], proof.pi_b[1][0]],
  ];
  const pC: [string, string] = [proof.pi_c[0], proof.pi_c[1]];
  return AbiCoder.defaultAbiCoder().encode(
    ["uint256[2]", "uint256[2][2]", "uint256[2]"],
    [pA, pB, pC]
  );
}
