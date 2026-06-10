// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Vault} from "../src/Vault.sol";

/// @notice Post-deploy governance: set the SEC-007 aggregate cap on USDC deployed to
/// Polymarket. The Vault initializes deploymentCap = type(uint256).max (unlimited); for a
/// mainnet test, cap it small to bound a compromised operator. onlyOwner.
///
/// Required env vars: VAULT_ADDRESS, DEPLOYMENT_CAP (raw USDC base units, 6 decimals;
///   e.g. 1000000000 = $1,000)
/// Signing: encrypted keystore — provide --account <name> --sender <ownerAddr>.
///
/// Usage:
///   DEPLOYMENT_CAP=1000000000 forge script script/SetDeploymentCap.s.sol \
///     --rpc-url $POLYGON_RPC_URL --account deployer --sender $DEPLOYER_ADDRESS --broadcast
contract SetDeploymentCap is Script {
    function run() external {
        Vault vault = Vault(vm.envAddress("VAULT_ADDRESS"));
        uint256 cap = vm.envUint("DEPLOYMENT_CAP");

        vm.startBroadcast();
        vault.setDeploymentCap(cap);
        vm.stopBroadcast();

        console2.log("deploymentCap set to (USDC base units):", cap);
    }
}
