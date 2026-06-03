// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin-upgradeable/access/OwnableUpgradeable.sol";
import {PoseidonT3} from "@poseidon-solidity/PoseidonT3.sol";
import {IPoseidonT3} from "./interfaces/IPoseidonT3.sol";

/// @notice Thin contract wrapper around the PoseidonT3 library so it can be
///         deployed at an address and called via IPoseidonT3.
///         Uses BN254 Poseidon constants — identical to Noir's bn254::hash_2.
///
/// UUPS-upgradeable. The hashing function is stateless and remains `pure`; the
/// owner/UUPS machinery exists only to gate `_authorizeUpgrade`. The committed
/// hash math is never read from storage, so `poseidon()` keeps its `pure` ABI.
contract PoseidonT3Hasher is Initializable, UUPSUpgradeable, OwnableUpgradeable, IPoseidonT3 {
    /// @dev Reserved storage for future UUPS upgrades.
    uint256[50] private __gap;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _owner) external initializer {
        __Ownable_init(_owner);
    }

    function poseidon(uint256[2] calldata inputs) external pure returns (uint256) {
        return PoseidonT3.hash([inputs[0], inputs[1]]);
    }

    /// @notice UUPS upgrade authorization. Owner-gated, instant (no timelock).
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
