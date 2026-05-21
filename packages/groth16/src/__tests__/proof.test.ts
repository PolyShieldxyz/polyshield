import { deserializeGroth16Proof, serializeGroth16Proof } from "../proof";

describe("Groth16 proof serialization", () => {
  it("round-trips abi encoded proof bytes", () => {
    const encoded = serializeGroth16Proof({
      pi_a: [1n, 2n],
      pi_b: [
        [3n, 4n],
        [5n, 6n],
      ],
      pi_c: [7n, 8n],
    });

    expect(deserializeGroth16Proof(encoded)).toEqual({
      a: [1n, 2n],
      b: [
        [3n, 4n],
        [5n, 6n],
      ],
      c: [7n, 8n],
    });
  });
});
