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
///   fundPolymarketWallet (USDC → pUSD → proxy)
///   → relayer WALLET batch on the proxy (approve → offramp.withdraw → transfer to Vault)
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

    /// Full JIT money path: fund → relayer offramp batch → acknowledge.
    function test_jitFund_relayerOfframp_acknowledge() public {
        // 1) JIT funding: operator deploys the exact amount to the proxy.
        vm.prank(operator);
        vault.fundPolymarketWallet(AMT);
        assertEq(pusd.balanceOf(address(proxy)), AMT, "proxy should hold pUSD");
        assertEq(vault.deployedToPolymarket(), AMT, "deployedToPolymarket tracks the funding");
        assertEq(usdc.balanceOf(address(vault)), 0, "vault USDC was converted out");

        // 2) Settlement: relayer submits a WALLET batch ON the proxy:
        //    approve(offramp) → offramp.withdraw → transfer USDC to the Vault.
        MockDepositWallet.Call[] memory calls = new MockDepositWallet.Call[](3);
        calls[0] = MockDepositWallet.Call({
            target: address(pusd),
            value: 0,
            data: abi.encodeWithSignature("approve(address,uint256)", address(offramp), AMT)
        });
        calls[1] = MockDepositWallet.Call({
            target: address(offramp),
            value: 0,
            data: abi.encodeWithSignature("withdraw(uint256)", AMT)
        });
        calls[2] = MockDepositWallet.Call({
            target: address(usdc),
            value: 0,
            data: abi.encodeWithSignature("transfer(address,uint256)", address(vault), AMT)
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
        // The proxy now holds AMT pUSD. A subsequent bet of <= AMT needs no new onramp:
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
}
