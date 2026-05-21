import { AbiCoder } from "ethers";

import type { BigNumberish, Groth16Proof } from "./interfaces";
import { toBigInt } from "./publicInputs";

const coder = AbiCoder.defaultAbiCoder();

export interface DecodedGroth16Proof {
  a: [bigint, bigint];
  b: [[bigint, bigint], [bigint, bigint]];
  c: [bigint, bigint];
}

export function serializeGroth16Proof(proof: Groth16Proof): string {
  const a: [bigint, bigint] = [toBigInt(proof.pi_a[0]), toBigInt(proof.pi_a[1])];
  const b: [[bigint, bigint], [bigint, bigint]] = [
    [toBigInt(proof.pi_b[0][0]), toBigInt(proof.pi_b[0][1])],
    [toBigInt(proof.pi_b[1][0]), toBigInt(proof.pi_b[1][1])],
  ];
  const c: [bigint, bigint] = [toBigInt(proof.pi_c[0]), toBigInt(proof.pi_c[1])];

  return coder.encode(["uint256[2]", "uint256[2][2]", "uint256[2]"], [a, b, c]);
}

export function deserializeGroth16Proof(encoded: string): DecodedGroth16Proof {
  const [a, b, c] = coder.decode(["uint256[2]", "uint256[2][2]", "uint256[2]"], encoded) as unknown as [
    [BigNumberish, BigNumberish],
    [[BigNumberish, BigNumberish], [BigNumberish, BigNumberish]],
    [BigNumberish, BigNumberish],
  ];

  return {
    a: [toBigInt(a[0]), toBigInt(a[1])],
    b: [
      [toBigInt(b[0][0]), toBigInt(b[0][1])],
      [toBigInt(b[1][0]), toBigInt(b[1][1])],
    ],
    c: [toBigInt(c[0]), toBigInt(c[1])],
  };
}
