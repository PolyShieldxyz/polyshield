// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoseidonT3} from "@poseidon-solidity/PoseidonT3.sol";
import {IPoseidonT3} from "./interfaces/IPoseidonT3.sol";

/// @notice Thin contract wrapper around the PoseidonT3 library so it can be
///         deployed at an address and called via IPoseidonT3.
///         Uses BN254 Poseidon constants — identical to Noir's bn254::hash_2.
contract PoseidonT3Hasher is IPoseidonT3 {
    function poseidon(uint256[2] calldata inputs) external pure returns (uint256) {
        return PoseidonT3.hash([inputs[0], inputs[1]]);
    }
}
