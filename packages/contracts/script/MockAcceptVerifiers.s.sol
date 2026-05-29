// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {Vault} from "../src/Vault.sol";

/// @notice Second pass of the mock deploy: accept all five verifiers after the
/// 48-hour timelock has been advanced by deploy.ts via evm_increaseTime + evm_mine.
///
/// Usage (called by deploy.ts, never run manually):
///   VAULT_ADDRESS=0x... forge script script/MockAcceptVerifiers.s.sol \
///     --rpc-url http://127.0.0.1:8545 --broadcast
contract MockAcceptVerifiers is Script {
    uint256 constant DEPLOYER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function run() external {
        address vaultAddr = vm.envAddress("VAULT_ADDRESS");
        Vault vault = Vault(vaultAddr);

        vm.startBroadcast(DEPLOYER_KEY);
        vault.acceptVerifier(vault.BET_AUTH());
        vault.acceptVerifier(vault.SETTLEMENT_CREDIT());
        vault.acceptVerifier(vault.WITHDRAWAL());
        vault.acceptVerifier(vault.BET_CANCEL());
        vault.acceptVerifier(vault.CANCEL_CREDIT());
        vm.stopBroadcast();
    }
}
