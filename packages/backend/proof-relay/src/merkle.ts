/**
 * Off-chain Merkle path computation for the CommitmentMerkleTree contract.
 *
 * Reconstructs the append-only Poseidon Merkle tree from on-chain LeafInserted events,
 * then generates a depth-32 inclusion proof for a given commitment.
 *
 * Hash function: poseidon2(left, right) from poseidon-lite — verified to match
 * the on-chain PoseidonT3.hash([left, right]) and Noir's bn254::hash_2([left, right]).
 */

import { ethers } from "ethers";
import { poseidon2 } from "poseidon-lite";

const TREE_DEPTH = 32;

// Precompute zero subtree hashes: zeros[0] = 0, zeros[i+1] = poseidon2(zeros[i], zeros[i])
function buildZeros(): bigint[] {
  const zeros: bigint[] = [0n];
  for (let i = 0; i < TREE_DEPTH - 1; i++) {
    zeros.push(poseidon2([zeros[i], zeros[i]]));
  }
  return zeros;
}

const ZEROS = buildZeros();

// hex-pad bigint to 0x-prefixed 32-byte hex
function toHex(n: bigint): string {
  return "0x" + n.toString(16).padStart(64, "0");
}

export interface MerkleProof {
  path: string[];       // 32 sibling hashes as 0x-prefixed hex
  pathIndices: number[] // 0 = current is left child, 1 = current is right child
  root: string          // 0x-prefixed current root
  leafIndex: number
}

const LEAF_INSERTED_TOPIC = ethers.id("LeafInserted(uint32,bytes32,bytes32)");

export async function computeMerkleProof(
  treeAddress: string,
  commitment: string,
  provider: ethers.JsonRpcProvider,
): Promise<MerkleProof | null> {
  // 1. Fetch all LeafInserted events
  const logs = await provider.getLogs({
    address: treeAddress,
    topics: [LEAF_INSERTED_TOPIC],
    fromBlock: 0,
    toBlock: "latest",
  });

  // Parse leaves in insertion order
  const leaves: bigint[] = [];
  for (const log of logs) {
    // LeafInserted(uint32 indexed leafIndex, bytes32 leaf, bytes32 newRoot)
    const iface = new ethers.Interface([
      "event LeafInserted(uint32 indexed leafIndex, bytes32 leaf, bytes32 newRoot)",
    ]);
    const parsed = iface.parseLog(log);
    if (!parsed) continue;
    const leafIndex = Number(parsed.args[0]);
    const leaf = BigInt(parsed.args[1] as string);
    leaves[leafIndex] = leaf;
  }

  const target = BigInt(commitment);
  const targetIdx = leaves.findIndex((l) => l === target);
  if (targetIdx === -1) return null;

  // 2. Build the proof by walking up the tree layer by layer
  const n = leaves.length;
  const path: bigint[] = [];
  const pathIndices: number[] = [];

  let layer: bigint[] = [...leaves];
  let idx = targetIdx;

  for (let level = 0; level < TREE_DEPTH; level++) {
    const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;

    // Sibling value: use actual leaf/node if it exists, else the zero subtree hash
    const sibling = siblingIdx < layer.length ? layer[siblingIdx] : ZEROS[level];
    path.push(sibling);
    pathIndices.push(idx % 2); // 0 = we're left child, 1 = we're right child

    // Build the next layer up
    const nextLayer: bigint[] = [];
    for (let j = 0; j < Math.max(layer.length, 1); j += 2) {
      const left = j < layer.length ? layer[j] : ZEROS[level];
      const right = j + 1 < layer.length ? layer[j + 1] : ZEROS[level];
      nextLayer.push(poseidon2([left, right]));
    }

    layer = nextLayer;
    idx = Math.floor(idx / 2);
  }

  // Root is what remains after all 32 levels
  const root = layer[0] ?? ZEROS[TREE_DEPTH];

  return {
    path: path.map(toHex),
    pathIndices,
    root: toHex(root),
    leafIndex: targetIdx,
  };
}
