// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../src/Vault.sol";
import {CommitmentMerkleTree} from "../src/CommitmentMerkleTree.sol";
import {NullifierRegistry} from "../src/NullifierRegistry.sol";
import {DepositVerifier} from "../src/verifiers/DepositVerifier.sol";
import {MockPoseidonT3} from "../src/mocks/MockPoseidonT3.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockCTF} from "../src/mocks/MockCTF.sol";
import {MockPUSD} from "../src/mocks/MockPUSD.sol";
import {MockCollateralOnramp} from "../src/mocks/MockCollateralOnramp.sol";
import {MockCollateralOfframp} from "../src/mocks/MockCollateralOfframp.sol";
import {DeployLib} from "../script/DeployLib.sol";

/// @notice Minimal V2 implementation used to exercise a real UUPS upgrade. Inherits
/// the full Vault (preserving its storage layout) and adds one new function.
contract VaultV2 is Vault {
    function version() external pure returns (uint256) {
        return 2;
    }
}

/// @notice UUPS upgrade safety tests: storage preservation across an implementation
/// swap, owner-gated `_authorizeUpgrade`, and the verifier `setBase` upgrade lever.
contract UpgradeTest is Test {
    Vault vault;
    CommitmentMerkleTree tree;
    NullifierRegistry registry;
    MockPoseidonT3 poseidon;
    MockUSDC usdc;
    MockCTF ctf;
    MockCollateralOnramp onramp;
    MockCollateralOfframp offramp;

    address owner = address(0x1111);
    address operator = address(0x2222);
    address depositWallet = address(0x3333);
    address attacker = address(0xBAD0);

    function setUp() public {
        poseidon = new MockPoseidonT3();
        usdc = new MockUSDC();
        MockPUSD pusd = new MockPUSD();
        ctf = new MockCTF(address(pusd));
        onramp = new MockCollateralOnramp(address(usdc), address(pusd));
        offramp = new MockCollateralOfframp(address(usdc), address(pusd));

        address registryImpl = address(new NullifierRegistry());
        address treeImpl = address(new CommitmentMerkleTree());
        address vaultImpl = address(new Vault());
        address predictedVault = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);

        registry = NullifierRegistry(
            DeployLib.deployProxy(registryImpl, abi.encodeCall(NullifierRegistry.initialize, (predictedVault, owner)))
        );
        tree = CommitmentMerkleTree(
            DeployLib.deployProxy(
                treeImpl, abi.encodeCall(CommitmentMerkleTree.initialize, (predictedVault, address(poseidon), owner))
            )
        );
        vault = Vault(
            DeployLib.deployVaultProxy(
                vaultImpl,
                DeployLib.VaultInit({
                    usdc: address(usdc),
                    tree: address(tree),
                    registry: address(registry),
                    onramp: address(onramp),
                    offramp: address(offramp),
                    ctf: address(ctf),
                    operator: operator,
                    depositWallet: depositWallet,
                    owner: owner
                })
            )
        );
        require(address(vault) == predictedVault, "UpgradeTest: vault proxy addr mismatch");
    }

    // ── Vault upgrade ────────────────────────────────────────────────────────

    function test_upgrade_preservesStateAndAddsBehavior() public {
        // Mutate distinctive state through the proxy.
        vm.startPrank(owner);
        vault.setDeploymentCap(12_345);
        vault.setAdminCancelTimelock(4 days); // FC-9: setter floor is 3 days
        vm.stopPrank();

        // Sanity: defaults set in initialize() are present (storage, not impl bytecode).
        assertEq(vault.deploymentCap(), 12_345);
        assertEq(vault.adminCancelTimelock(), 4 days);
        assertEq(address(vault.tree()), address(tree));
        assertEq(vault.owner(), owner);

        // Upgrade to V2.
        address v2 = address(new VaultV2());
        vm.prank(owner);
        vault.upgradeToAndCall(v2, "");

        // New behavior present...
        assertEq(VaultV2(address(vault)).version(), 2, "V2 logic active");
        // ...and ALL prior storage preserved across the implementation swap.
        assertEq(vault.deploymentCap(), 12_345, "deploymentCap preserved");
        assertEq(vault.adminCancelTimelock(), 4 days, "adminCancelTimelock preserved");
        assertEq(address(vault.tree()), address(tree), "tree wiring preserved");
        assertEq(address(vault.usdc()), address(usdc), "usdc wiring preserved");
        assertEq(vault.owner(), owner, "owner preserved");
    }

    function test_upgrade_revertsForNonOwner() public {
        address v2 = address(new VaultV2());
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", attacker));
        vault.upgradeToAndCall(v2, "");
    }

    function test_treeAndRegistry_areUpgradeable() public {
        // Tree and registry are independent UUPS proxies, owner-gated.
        address treeV2 = address(new CommitmentMerkleTree());
        vm.prank(owner);
        tree.upgradeToAndCall(treeV2, "");
        assertEq(tree.vault(), address(vault), "tree.vault preserved across upgrade");

        // Pre-create the impl BEFORE arming expectRevert so the cheatcode targets the
        // upgrade call (not the CREATE, which would not revert).
        address regV2 = address(new NullifierRegistry());
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", attacker));
        registry.upgradeToAndCall(regV2, "");
    }

    // ── Verifier proxy upgrade levers ────────────────────────────────────────

    function test_verifier_setBase_ownerOnly() public {
        DepositVerifier v =
            DepositVerifier(DeployLib.deployOwnedProxy(address(new DepositVerifier()), owner));
        address originalBase = v.base();
        assertTrue(originalBase != address(0), "initialize deployed a base");

        address newBase = address(0xBA5E);
        vm.prank(owner);
        v.setBase(newBase);
        assertEq(v.base(), newBase, "owner can re-point base (VK re-key)");

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", attacker));
        v.setBase(address(0xDEAD));
    }
}
