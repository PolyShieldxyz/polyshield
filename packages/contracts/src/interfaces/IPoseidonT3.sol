// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Interface for a 2-input Poseidon hash over BN254.
/// PoseidonT3 in iden3/zk-kit naming (t = state size = 3 = 2 inputs + 1 capacity).
/// Must match Noir stdlib's `dep::std::hash::poseidon::bn254::hash_2` exactly.
interface IPoseidonT3 {
    function poseidon(uint256[2] calldata inputs) external pure returns (uint256);
}
