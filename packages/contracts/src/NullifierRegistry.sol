// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Tracks spent nullifiers to prevent double-spending notes.
/// Only the registered Vault may mark nullifiers spent.
contract NullifierRegistry {
    address public immutable vault;
    mapping(bytes32 => bool) public spent;

    error OnlyVault();
    error AlreadySpent();

    constructor(address _vault) {
        vault = _vault;
    }

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
