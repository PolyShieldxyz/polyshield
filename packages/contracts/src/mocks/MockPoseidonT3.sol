// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoseidonT3} from "../interfaces/IPoseidonT3.sol";

/// @notice Test Poseidon hasher that uses keccak256 for determinism.
/// Only used in tests; NOT cryptographically equivalent to real Poseidon.
contract MockPoseidonT3 is IPoseidonT3 {
    function poseidon(uint256[2] calldata inputs) external pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(inputs[0], inputs[1])));
    }
}
