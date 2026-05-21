// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoseidonT3} from "../interfaces/IPoseidonT3.sol";

/// @notice Test hasher that maps deterministic keccak output into the bn254 scalar field.
/// This is not real Poseidon, but it preserves the "hash stays inside the field" property
/// required by the Groth16 adapter layer.
contract MockPoseidonField is IPoseidonT3 {
    uint256 internal constant BN254_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    function poseidon(uint256[2] calldata inputs) external pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(inputs[0], inputs[1]))) % BN254_SCALAR_FIELD;
    }
}
