// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Local-dev stand-in for a Polymarket post-April-2026 deposit wallet.
///
/// In production, betting collateral (pUSD) and CTF outcome shares live inside a
/// per-account ERC-1967 proxy, and all wallet actions (redeemPositions, pUSD
/// approvals, offramp, transfers back to the Vault) are executed by the Polymarket
/// relayer as signed `WALLET` batch transactions — never as direct EOA calls.
///
/// This mock mirrors that surface with a minimal relayer-gated `execute` /
/// `executeBatch`, so the signing layer's `DepositWalletExecutor` runs the SAME
/// code path against the mock relayer here and the real relayer in production.
/// The `Vault.depositWallet` is set to this contract; `fundPolymarketWallet`
/// forwards pUSD here, and the mock CLOB drives fills/settlement through the
/// relayer against this contract. It is NOT a faithful ERC-1967 implementation —
/// it only models the authorization + batch-execution semantics needed for tests.
contract MockDepositWallet is ReentrancyGuard {
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    address public owner;   // can rotate the relayer; analogous to the wallet's controller
    address public relayer; // authorized batch executor (mock twin of the Polymarket relayer)

    error NotAuthorized();
    error CallFailed(uint256 index);

    event RelayerUpdated(address indexed relayer);
    event Executed(address indexed target, uint256 value);

    constructor(address _owner, address _relayer) {
        owner = _owner;
        relayer = _relayer;
    }

    modifier onlyAuthorized() {
        if (msg.sender != relayer && msg.sender != owner) revert NotAuthorized();
        _;
    }

    /// @notice Rotate the authorized relayer. Owner-only.
    function setRelayer(address _relayer) external {
        if (msg.sender != owner) revert NotAuthorized();
        relayer = _relayer;
        emit RelayerUpdated(_relayer);
    }

    /// @notice Execute a single call as the deposit wallet.
    function execute(address target, uint256 value, bytes calldata data)
        external
        onlyAuthorized
        nonReentrant
        returns (bytes memory)
    {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) revert CallFailed(0);
        emit Executed(target, value);
        return ret;
    }

    /// @notice Execute a batch of calls as the deposit wallet (atomic — reverts the
    /// whole batch on the first failing call, like a relayer WALLET batch).
    function executeBatch(Call[] calldata calls) external onlyAuthorized nonReentrant {
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, ) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!ok) revert CallFailed(i);
            emit Executed(calls[i].target, calls[i].value);
        }
    }

    receive() external payable {}
}
