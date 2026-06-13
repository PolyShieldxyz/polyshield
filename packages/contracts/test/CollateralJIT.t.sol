// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../src/Vault.sol";
import {NullifierRegistry} from "../src/NullifierRegistry.sol";
import {CommitmentMerkleTree} from "../src/CommitmentMerkleTree.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockPUSD} from "../src/mocks/MockPUSD.sol";
import {MockCTF} from "../src/mocks/MockCTF.sol";
import {MockCollateralOnramp} from "../src/mocks/MockCollateralOnramp.sol";
import {MockCollateralOfframp} from "../src/mocks/MockCollateralOfframp.sol";
import {MockDepositWallet} from "../src/mocks/MockDepositWallet.sol";
import {MockPoseidonT3} from "../src/mocks/MockPoseidonT3.sol";
import {DeployLib} from "../script/DeployLib.sol";

/// @notice Integration test for the JIT (Option 3 / FC-7) collateral money path on real
/// contracts, exercising the deposit-wallet proxy + relayer model end-to-end:
///   fundPolymarketWallet (USDC → proxy) → proxy wraps USDC → pUSD via the onramp
///   → relayer WALLET batch (approve pUSD → offramp.unwrap(USDC, Vault, amt)) → USDC to Vault
///   → acknowledgePolymarketReturn.
/// This is the on-chain core of what the signing layer's jitFunding + DepositWalletExecutor
/// drive; it deterministically validates the contract/script changes without the service stack.
contract CollateralJITTest is Test {
    MockUSDC usdc;
    MockPUSD pusd;
    MockCTF ctf;
    MockCollateralOnramp onramp;
    MockCollateralOfframp offramp;
    MockDepositWallet proxy;
    Vault vault;
    NullifierRegistry registry;
    CommitmentMerkleTree tree;
    MockPoseidonT3 poseidon;

    address owner = makeAddr("owner");
    address operator = makeAddr("operator");
    address relayer = makeAddr("relayer");

    uint256 constant AMT = 1_000 * 1e6; // $1000

    function setUp() public {
        poseidon = new MockPoseidonT3();
        usdc = new MockUSDC();
        pusd = new MockPUSD();
        ctf = new MockCTF(address(pusd));
        onramp = new MockCollateralOnramp(address(usdc), address(pusd));
        offramp = new MockCollateralOfframp(address(usdc), address(pusd));
        // Deposit-wallet proxy (post-April-2026 model): relayer-gated batch executor.
        proxy = new MockDepositWallet(owner, relayer);

        // UUPS: deploy impls, then proxies. registryProxy(+0), treeProxy(+1), vaultProxy(+2)
        // must be the next three CREATEs after the impls.
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
                    depositWallet: address(proxy), // depositWallet = proxy
                    owner: owner
                })
            )
        );
        require(address(vault) == predictedVault, "CollateralJITTest: vault proxy addr mismatch");

        // Seed the Vault with USDC at rest (stands in for user deposits).
        usdc.mint(address(vault), AMT);
    }

    /// Full JIT money path on real contracts: fund (USDC→proxy) → proxy wraps USDC→pUSD →
    /// relayer offramp batch (verified unwrap pUSD→USDC straight to the Vault) → acknowledge.
    function test_jitFund_relayerOfframp_acknowledge() public {
        // 1) JIT funding: operator forwards USDC.e to the proxy (current model — the pUSD hop
        //    happens on the proxy via the onramp, not in fundPolymarketWallet).
        vm.prank(operator);
        vault.fundPolymarketWallet(AMT);
        assertEq(usdc.balanceOf(address(proxy)), AMT, "proxy should hold the funded USDC");
        assertEq(vault.deployedToPolymarket(), AMT, "deployedToPolymarket tracks the funding");
        assertEq(usdc.balanceOf(address(vault)), 0, "vault USDC deployed out");

        // 2) The proxy wraps its USDC -> pUSD via the onramp (relayer WALLET batch) — the
        //    deposit wallet's buying-power prep.
        MockDepositWallet.Call[] memory wrap = new MockDepositWallet.Call[](2);
        wrap[0] = MockDepositWallet.Call({
            target: address(usdc),
            value: 0,
            data: abi.encodeWithSignature("approve(address,uint256)", address(onramp), AMT)
        });
        wrap[1] = MockDepositWallet.Call({
            target: address(onramp),
            value: 0,
            data: abi.encodeWithSignature("deposit(uint256)", AMT)
        });
        vm.prank(relayer);
        proxy.executeBatch(wrap);
        assertEq(pusd.balanceOf(address(proxy)), AMT, "proxy wrapped USDC into pUSD");

        // 3) Settlement/reclaim: relayer offramp batch on the proxy — approve pUSD, then the
        //    VERIFIED unwrap(USDC, Vault, AMT) sends USDC.e straight back to the Vault (no
        //    separate transfer). Mirrors redemptionPipeline.offrampPusdToVault.
        MockDepositWallet.Call[] memory calls = new MockDepositWallet.Call[](2);
        calls[0] = MockDepositWallet.Call({
            target: address(pusd),
            value: 0,
            data: abi.encodeWithSignature("approve(address,uint256)", address(offramp), AMT)
        });
        calls[1] = MockDepositWallet.Call({
            target: address(offramp),
            value: 0,
            data: abi.encodeWithSignature("unwrap(address,address,uint256)", address(usdc), address(vault), AMT)
        });
        vm.prank(relayer);
        proxy.executeBatch(calls);
        assertEq(usdc.balanceOf(address(vault)), AMT, "USDC returned to the Vault");
        assertEq(pusd.balanceOf(address(proxy)), 0, "proxy pUSD fully offramped");

        // 3) Operator acknowledges the returned capital.
        vm.prank(operator);
        vault.acknowledgePolymarketReturn(AMT);
        assertEq(vault.deployedToPolymarket(), 0, "deployedToPolymarket cleared");
    }

    /// Residual-buffer reuse: a second JIT-funding for an amount already covered by the
    /// proxy's residual pUSD requires no further vault USDC movement (handled off-chain by
    /// jitFunding's balance check; here we assert the proxy can already cover it).
    function test_residualBuffer_coversNextBet() public {
        vm.prank(operator);
        vault.fundPolymarketWallet(AMT);
        // The proxy wraps the funded USDC -> pUSD; that pUSD is the residual buffer a later
        // bet of <= AMT reuses with no new onramp.
        MockDepositWallet.Call[] memory wrap = new MockDepositWallet.Call[](2);
        wrap[0] = MockDepositWallet.Call({
            target: address(usdc),
            value: 0,
            data: abi.encodeWithSignature("approve(address,uint256)", address(onramp), AMT)
        });
        wrap[1] = MockDepositWallet.Call({
            target: address(onramp),
            value: 0,
            data: abi.encodeWithSignature("deposit(uint256)", AMT)
        });
        vm.prank(relayer);
        proxy.executeBatch(wrap);
        assertGe(pusd.balanceOf(address(proxy)), AMT, "residual buffer covers the next bet");
    }

    /// The proxy only executes batches from its relayer/owner (fenced outbound path).
    function test_proxy_rejectsUnauthorizedBatch() public {
        MockDepositWallet.Call[] memory calls = new MockDepositWallet.Call[](1);
        calls[0] = MockDepositWallet.Call({
            target: address(usdc),
            value: 0,
            data: abi.encodeWithSignature("transfer(address,uint256)", address(this), uint256(1))
        });
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(MockDepositWallet.NotAuthorized.selector);
        proxy.executeBatch(calls);
    }

    /// fundPolymarketWallet respects the SEC-007 deployment cap (bounds JIT exposure).
    function test_fund_revertsAboveDeploymentCap() public {
        vm.prank(owner);
        vault.setDeploymentCap(AMT - 1);
        vm.prank(operator);
        vm.expectRevert(Vault.DeployCapExceeded.selector);
        vault.fundPolymarketWallet(AMT);
    }

    /// adminSweep (testing-phase escape hatch): owner rescues USDC locked behind a burned nullifier.
    function test_adminSweep_ownerRescuesUsdc() public {
        address rescuer = makeAddr("rescuer");
        uint256 bal = usdc.balanceOf(address(vault));
        assertGt(bal, 0, "vault seeded with USDC");
        vm.prank(owner);
        vault.adminSweep(rescuer, bal);
        assertEq(usdc.balanceOf(rescuer), bal, "rescuer received the swept USDC");
        assertEq(usdc.balanceOf(address(vault)), 0, "vault USDC fully swept");
    }

    function test_adminSweep_revertNotOwner() public {
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(); // Ownable2Step: OwnableUnauthorizedAccount
        vault.adminSweep(makeAddr("x"), 1);
    }

    function test_adminSweep_revertZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(Vault.ZeroAddress.selector);
        vault.adminSweep(address(0), 1);
    }
}
