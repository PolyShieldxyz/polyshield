// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin-upgradeable/access/OwnableUpgradeable.sol";

/// @notice Tracks spent nullifiers to prevent double-spending notes.
/// Only the registered Vault may mark nullifiers spent. UUPS-upgradeable.
contract NullifierRegistry is Initializable, UUPSUpgradeable, OwnableUpgradeable {
    address public vault; // was immutable; now proxy storage
    mapping(bytes32 => bool) public spent;

    /// @dev Reserved storage for future UUPS upgrades.
    uint256[50] private __gap;

    error OnlyVault();
    error AlreadySpent();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _vault, address _owner) external initializer {
        __Ownable_init(_owner);
        vault = _vault;
    }

    /// @notice UUPS upgrade authorization. Owner-gated, instant (no timelock).
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    function markSpent(bytes32 nullifier) external onlyVault {
        if (spent[nullifier]) revert AlreadySpent();
        spent[nullifier] = true;
    }

    function isSpent(bytes32 nullifier) external view returns (bool) {
        return spent[nullifier];
    }
}
