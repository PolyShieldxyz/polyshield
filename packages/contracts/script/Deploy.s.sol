// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {NullifierRegistry} from "../src/NullifierRegistry.sol";
import {CommitmentMerkleTree} from "../src/CommitmentMerkleTree.sol";
import {Vault} from "../src/Vault.sol";

/// @notice Deploy NullifierRegistry, CommitmentMerkleTree, Vault.
///
/// Required env vars (set via .env before running):
///   DEPLOYER_PRIVATE_KEY, USDC_ADDRESS, POSEIDON_T3_ADDRESS,
///   ONRAMP_ADDRESS, OFFRAMP_ADDRESS, CTF_ADDRESS,
///   SIGNING_LAYER_OPERATOR, DEPOSIT_WALLET, OWNER_ADDRESS
///
/// Usage:
///   forge script script/Deploy.s.sol --rpc-url $POLYGON_RPC_URL --broadcast
contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        address usdc = vm.envAddress("USDC_ADDRESS");
        address poseidon = vm.envAddress("POSEIDON_T3_ADDRESS");
        address onramp = vm.envAddress("ONRAMP_ADDRESS");
        address offramp = vm.envAddress("OFFRAMP_ADDRESS");
        address ctfAddr = vm.envAddress("CTF_ADDRESS");
        address operator = vm.envAddress("SIGNING_LAYER_OPERATOR");
        address depositWallet = vm.envAddress("DEPOSIT_WALLET");
        address owner = vm.envAddress("OWNER_ADDRESS");

        vm.startBroadcast(deployerKey);

        // 1. Predict vault address so NullifierRegistry and CommitmentMerkleTree
        //    can reference it before Vault is deployed.
        uint64 nonce = vm.getNonce(deployer);
        // NullifierRegistry is nonce, CommitmentMerkleTree is nonce+1, Vault is nonce+2
        address predictedVault = vm.computeCreateAddress(deployer, nonce + 2);

        NullifierRegistry registry = new NullifierRegistry(predictedVault);
        CommitmentMerkleTree tree = new CommitmentMerkleTree(predictedVault, poseidon);
        Vault vault = new Vault(
            usdc,
            address(tree),
            address(registry),
            onramp,
            offramp,
            ctfAddr,
            operator,
            depositWallet,
            owner
        );

        require(address(vault) == predictedVault, "Deploy: vault address mismatch");

        vm.stopBroadcast();

        console2.log("NullifierRegistry:", address(registry));
        console2.log("CommitmentMerkleTree:", address(tree));
        console2.log("Vault:", address(vault));
    }
}
