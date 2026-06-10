// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PoseidonT3Hasher} from "../src/PoseidonT3Hasher.sol";
import {DeployLib} from "./DeployLib.sol";

/// @notice STEP 0 of the mainnet deploy. The production Deploy.s.sol expects
/// POSEIDON_T3_ADDRESS to already exist; no production script deployed it (only the
/// local MockDeploy did, inline). Run this first and export the logged proxy address
/// as POSEIDON_T3_ADDRESS before running Deploy.s.sol.
///
/// PoseidonT3Hasher is a UUPS implementation behind an ERC1967 proxy; the proxy
/// address is the permanent protocol address. Owner = OWNER_ADDRESS (initialize(address)).
///
/// Required env vars: OWNER_ADDRESS
/// Signing: encrypted keystore — provide --account <name> --sender <deployerAddr>.
///
/// Usage:
///   forge script script/DeployPoseidon.s.sol --rpc-url $POLYGON_RPC_URL \
///     --account deployer --sender $DEPLOYER_ADDRESS --broadcast --verify
contract DeployPoseidon is Script {
    function run() external {
        address owner = vm.envAddress("OWNER_ADDRESS");

        vm.startBroadcast();
        address impl = address(new PoseidonT3Hasher());
        address proxy = DeployLib.deployOwnedProxy(impl, owner);
        vm.stopBroadcast();

        console2.log("PoseidonT3Hasher (impl):", impl);
        console2.log("POSEIDON_T3_ADDRESS=%s", proxy);
    }
}
