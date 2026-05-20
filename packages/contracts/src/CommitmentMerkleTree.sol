// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoseidonT3} from "./interfaces/IPoseidonT3.sol";

/// @notice Append-only Poseidon Merkle tree (depth 32) with a rolling root window.
///
/// Modelled after Tornado Cash's MerkleTreeWithHistory. The contract stores
/// the last HISTORY_SIZE roots so that ZK proofs generated against a recent
/// (but not current) root are still accepted.
///
/// The zero leaf is bytes32(0). Zero subtrees at each level are precomputed
/// in the constructor using the provided Poseidon hasher.
contract CommitmentMerkleTree {
    uint32 public constant TREE_DEPTH = 32;
    uint32 public constant HISTORY_SIZE = 30;

    IPoseidonT3 public immutable poseidon;
    address public immutable vault;

    bytes32[TREE_DEPTH] public zeros;
    bytes32[TREE_DEPTH] public filledSubtrees;

    bytes32[HISTORY_SIZE] public recentRoots;
    uint32 public currentRootIndex;
    uint32 public nextIndex;

    error OnlyVault();
    error TreeFull();

    event LeafInserted(uint32 indexed leafIndex, bytes32 leaf, bytes32 newRoot);

    constructor(address _vault, address _poseidon) {
        vault = _vault;
        poseidon = IPoseidonT3(_poseidon);

        // Precompute zero subtrees. Zero leaf = bytes32(0).
        bytes32 current = bytes32(0);
        for (uint32 i = 0; i < TREE_DEPTH; i++) {
            zeros[i] = current;
            filledSubtrees[i] = current;
            current = _hash(current, current);
        }

        // Store the initial root (all-zero tree)
        recentRoots[0] = current;
        currentRootIndex = 0;
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    /// @notice Insert a commitment leaf and return the new root.
    function insert(bytes32 commitment) external onlyVault returns (bytes32 newRoot) {
        uint32 index = nextIndex;
        if (index >= uint32(1) << TREE_DEPTH) revert TreeFull();
        nextIndex = index + 1;

        bytes32 current = commitment;
        uint32 idx = index;

        for (uint32 i = 0; i < TREE_DEPTH; i++) {
            if (idx % 2 == 0) {
                filledSubtrees[i] = current;
                current = _hash(current, zeros[i]);
            } else {
                current = _hash(filledSubtrees[i], current);
            }
            idx /= 2;
        }

        newRoot = current;
        uint32 newRootIndex = (currentRootIndex + 1) % HISTORY_SIZE;
        currentRootIndex = newRootIndex;
        recentRoots[newRootIndex] = newRoot;

        emit LeafInserted(index, commitment, newRoot);
    }

    /// @notice Returns true if `root` is in the last HISTORY_SIZE known roots.
    function isKnownRoot(bytes32 root) external view returns (bool) {
        if (root == bytes32(0)) return false;
        uint32 i = currentRootIndex;
        for (uint32 j = 0; j < HISTORY_SIZE; j++) {
            if (recentRoots[i] == root) return true;
            if (i == 0) {
                i = HISTORY_SIZE - 1;
            } else {
                i--;
            }
        }
        return false;
    }

    /// @notice Compute poseidon2(left, right). Used by Vault for recipient hash verification.
    function hashTwo(bytes32 left, bytes32 right) external view returns (bytes32) {
        return _hash(left, right);
    }

    function _hash(bytes32 left, bytes32 right) internal view returns (bytes32) {
        return bytes32(poseidon.poseidon([uint256(left), uint256(right)]));
    }
}
