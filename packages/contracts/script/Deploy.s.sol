// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {NullifierRegistry} from "../src/NullifierRegistry.sol";
import {CommitmentMerkleTree} from "../src/CommitmentMerkleTree.sol";
import {Vault} from "../src/Vault.sol";
import {DeployLib} from "./DeployLib.sol";

/// @notice Deploy NullifierRegistry, CommitmentMerkleTree, Vault — each as a
/// UUPS implementation behind an ERC1967 proxy. The proxy addresses are the
/// permanent protocol addresses; implementations are swappable via UUPS
/// (owner-gated, instant). `poseidon` is provided via env (deploy its proxy
/// separately and pass that address).
///
/// Required env vars (set via .env before running):
///   DEPLOYER_PRIVATE_KEY, USDC_ADDRESS, POSEIDON_T3_ADDRESS,
///   ONRAMP_ADDRESS, OFFRAMP_ADDRESS, CTF_ADDRESS,
///   SIGNING_LAYER_OPERATOR, DEPOSIT_WALLET, OWNER_ADDRESS
///
/// Usage:
///   forge script script/Deploy.s.sol --rpc-url $POLYGON_RPC_URL --broadcast
contract Deploy is Script {
    /// @dev External config bundled into a struct to keep `run()` under the EVM stack limit.
    struct Cfg {
        address usdc;
        address poseidon;
        address onramp;
        address offramp;
        address ctf;
        address operator;
        address depositWallet;
        address owner;
    }

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        Cfg memory c = Cfg({
            usdc: vm.envAddress("USDC_ADDRESS"),
            poseidon: vm.envAddress("POSEIDON_T3_ADDRESS"),
            onramp: vm.envAddress("ONRAMP_ADDRESS"),
            offramp: vm.envAddress("OFFRAMP_ADDRESS"),
            ctf: vm.envAddress("CTF_ADDRESS"),
            operator: vm.envAddress("SIGNING_LAYER_OPERATOR"),
            depositWallet: vm.envAddress("DEPOSIT_WALLET"),
            owner: vm.envAddress("OWNER_ADDRESS")
        });

        vm.startBroadcast(deployerKey);
        _deploy(c, vm.addr(deployerKey));
        vm.stopBroadcast();
    }

    function _deploy(Cfg memory c, address deployer) internal {
        // 1. Deploy implementations (no cyclic dependencies between them).
        address registryImpl = address(new NullifierRegistry());
        address treeImpl = address(new CommitmentMerkleTree());
        address vaultImpl = address(new Vault());

        // 2. Predict the Vault PROXY address so the registry/tree proxies can be
        //    initialized referencing it. The next three CREATEs by `deployer` are
        //    registryProxy(nonce), treeProxy(nonce+1), vaultProxy(nonce+2). The
        //    G16Base/inner CREATEs of other proxies are attributed to those proxies,
        //    not the deployer, so they do not perturb this count.
        address predictedVault = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 2);

        address registry = DeployLib.deployProxy(
            registryImpl, abi.encodeCall(NullifierRegistry.initialize, (predictedVault, c.owner))
        );
        address tree = DeployLib.deployProxy(
            treeImpl, abi.encodeCall(CommitmentMerkleTree.initialize, (predictedVault, c.poseidon, c.owner))
        );
        address vault = DeployLib.deployVaultProxy(
            vaultImpl,
            DeployLib.VaultInit({
                usdc: c.usdc,
                tree: tree,
                registry: registry,
                onramp: c.onramp,
                offramp: c.offramp,
                ctf: c.ctf,
                operator: c.operator,
                depositWallet: c.depositWallet,
                owner: c.owner
            })
        );

        require(vault == predictedVault, "Deploy: vault proxy address mismatch");

        console2.log("NullifierRegistry (proxy):", registry);
        console2.log("NullifierRegistry (impl):", registryImpl);
        console2.log("CommitmentMerkleTree (proxy):", tree);
        console2.log("CommitmentMerkleTree (impl):", treeImpl);
        console2.log("Vault (proxy):", vault);
        console2.log("Vault (impl):", vaultImpl);
    }
}
