// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Vault} from "../src/Vault.sol";

/// @notice STEP 3 (final) of the mainnet deploy — production analogue of the local
/// MockAcceptVerifiers.s.sol (which is hardcoded to the Anvil key). Run this only AFTER
/// VERIFIER_TIMELOCK (48h) has elapsed since DeployVerifiers.s.sol proposed the slots.
/// Until every slot is accepted, the corresponding proof type cannot be verified.
///
/// acceptVerifier is onlyOwner, so the BROADCASTER MUST BE THE VAULT OWNER. For this
/// test deploy owner == deployer EOA. If the owner is a multisig, emit these 9 calls as
/// Safe transactions instead of running this script.
///
/// Required env vars: VAULT_ADDRESS
/// Signing: encrypted keystore — provide --account <name> --sender <ownerAddr>.
///
/// Usage (>= 48h after DeployVerifiers):
///   forge script script/AcceptVerifiers.s.sol --rpc-url $POLYGON_RPC_URL \
///     --account deployer --sender $DEPLOYER_ADDRESS --broadcast
contract AcceptVerifiers is Script {
    function run() external {
        Vault vault = Vault(vm.envAddress("VAULT_ADDRESS"));

        vm.startBroadcast();
        vault.acceptVerifier(vault.BET_AUTH());
        vault.acceptVerifier(vault.SETTLEMENT_CREDIT());
        vault.acceptVerifier(vault.WITHDRAWAL());
        vault.acceptVerifier(vault.BET_CANCEL());
        vault.acceptVerifier(vault.CANCEL_CREDIT());
        vault.acceptVerifier(vault.DEPOSIT());
        vault.acceptVerifier(vault.POSITION_CLOSE());
        vault.acceptVerifier(vault.PARTIAL_CREDIT());
        vault.acceptVerifier(vault.CONSOLIDATE());
        vm.stopBroadcast();

        console2.log("All 9 verifiers accepted for Vault:", address(vault));
    }
}
