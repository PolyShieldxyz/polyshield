// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../src/Vault.sol";
import {CommitmentMerkleTree} from "../src/CommitmentMerkleTree.sol";
import {NullifierRegistry} from "../src/NullifierRegistry.sol";
import {MockVerifier} from "../src/mocks/MockVerifier.sol";
import {MockPoseidonT3} from "../src/mocks/MockPoseidonT3.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockCTF} from "../src/mocks/MockCTF.sol";
import {MockPUSD} from "../src/mocks/MockPUSD.sol";
import {MockCollateralOnramp} from "../src/mocks/MockCollateralOnramp.sol";
import {MockCollateralOfframp} from "../src/mocks/MockCollateralOfframp.sol";

contract VaultTest is Test {
    Vault public vault;
    CommitmentMerkleTree public tree;
    NullifierRegistry public registry;
    MockVerifier public betAuthVerifier;
    MockVerifier public settlementVerifier;
    MockVerifier public withdrawalVerifier;
    MockVerifier public betCancelVerifier;
    MockVerifier public cancelCreditVerifier;
    MockVerifier public depositVerifier;
    MockVerifier public positionCloseVerifier;
    MockVerifier public partialCreditVerifier;
    MockPoseidonT3 public poseidon;
    MockUSDC public usdc;
    MockCTF public ctf;
    MockCollateralOnramp public onramp;
    MockCollateralOfframp public offramp;

    address public owner = address(0x1111);
    address public operator = address(0x2222);
    address public depositWallet = address(0x3333);
    address public alice = address(0xA1CE);
    address public bob = address(0xB0B0);
    address public attacker = address(0xBAD0);
    address public recipient = address(0xBEEF);

    // Shared test data
    bytes32 constant COMMITMENT_1 = keccak256("commitment_1");
    bytes32 constant COMMITMENT_2 = keccak256("commitment_2");
    bytes32 constant COMMITMENT_3 = keccak256("commitment_3");
    bytes32 constant NULLIFIER_1 = keccak256("nullifier_1");
    bytes32 constant NULLIFIER_2 = keccak256("nullifier_2");
    bytes32 constant MARKET_ID = keccak256("market_1");
    bytes32 constant POSITION_ID = keccak256("position_1");
    uint256 constant DEPOSIT_AMOUNT = 1000 * 1e6; // $1k USDC
    uint256 constant DEPOSIT_CAP = 50_000 * 1e6;  // $50k USDC

    bytes public constant DUMMY_PROOF = hex"deadbeef";

    function setUp() public {
        poseidon = new MockPoseidonT3();
        usdc = new MockUSDC();
        ctf = new MockCTF(address(new MockPUSD()));
        MockPUSD pusd = new MockPUSD();
        onramp = new MockCollateralOnramp(address(usdc), address(pusd));
        offramp = new MockCollateralOfframp(address(usdc), address(pusd));

        // Deploy infrastructure with vault address = this contract initially,
        // then we re-deploy with the actual vault address
        address predictedVault = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);

        registry = new NullifierRegistry(predictedVault);
        tree = new CommitmentMerkleTree(predictedVault, address(poseidon));

        vault = new Vault(
            address(usdc),
            address(tree),
            address(registry),
            address(onramp),
            address(offramp),
            address(ctf),
            operator,
            depositWallet,
            owner
        );

        // Deploy mock verifiers
        betAuthVerifier = new MockVerifier(true);
        settlementVerifier = new MockVerifier(true);
        withdrawalVerifier = new MockVerifier(true);
        betCancelVerifier = new MockVerifier(true);
        cancelCreditVerifier = new MockVerifier(true);
        depositVerifier = new MockVerifier(true);
        positionCloseVerifier = new MockVerifier(true);
        partialCreditVerifier = new MockVerifier(true);

        // Wire verifiers — propose then accept after timelock
        vm.startPrank(owner);
        vault.proposeVerifier(vault.BET_AUTH(), address(betAuthVerifier));
        vault.proposeVerifier(vault.SETTLEMENT_CREDIT(), address(settlementVerifier));
        vault.proposeVerifier(vault.WITHDRAWAL(), address(withdrawalVerifier));
        vault.proposeVerifier(vault.BET_CANCEL(), address(betCancelVerifier));
        vault.proposeVerifier(vault.CANCEL_CREDIT(), address(cancelCreditVerifier));
        vault.proposeVerifier(vault.DEPOSIT(), address(depositVerifier));
        vault.proposeVerifier(vault.POSITION_CLOSE(), address(positionCloseVerifier));
        vault.proposeVerifier(vault.PARTIAL_CREDIT(), address(partialCreditVerifier));
        vm.stopPrank();
        vm.warp(block.timestamp + 48 hours + 1);
        vm.startPrank(owner);
        vault.acceptVerifier(vault.BET_AUTH());
        vault.acceptVerifier(vault.SETTLEMENT_CREDIT());
        vault.acceptVerifier(vault.WITHDRAWAL());
        vault.acceptVerifier(vault.BET_CANCEL());
        vault.acceptVerifier(vault.CANCEL_CREDIT());
        vault.acceptVerifier(vault.DEPOSIT());
        vault.acceptVerifier(vault.POSITION_CLOSE());
        vault.acceptVerifier(vault.PARTIAL_CREDIT());
        vm.stopPrank();

        // Fund Alice with USDC
        usdc.mint(alice, DEPOSIT_CAP + DEPOSIT_AMOUNT);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);

        // Fund Bob
        usdc.mint(bob, DEPOSIT_AMOUNT);
        vm.prank(bob);
        usdc.approve(address(vault), type(uint256).max);
    }

    // =========================================================================
    // Helper: current Merkle root for use in proof inputs
    // =========================================================================

    function _currentRoot() internal view returns (bytes32) {
        return tree.recentRoots(tree.currentRootIndex());
    }

    // =========================================================================
    // Deposit
    // =========================================================================

    function test_deposit_succeeds() public {
        vm.prank(alice);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_AMOUNT);
        assertEq(vault.cumulativeDeposits(alice), DEPOSIT_AMOUNT);
        assertEq(usdc.balanceOf(address(vault)), DEPOSIT_AMOUNT);
    }

    function test_deposit_emitsEvent() public {
        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit Vault.Deposited(alice, COMMITMENT_1, DEPOSIT_AMOUNT);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_AMOUNT);
    }

    function test_deposit_exactCapSucceeds() public {
        vm.prank(alice);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_CAP);
    }

    function test_deposit_revert_capExceeded() public {
        vm.prank(alice);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_CAP);
        vm.prank(alice);
        vm.expectRevert(Vault.DepositCapExceeded.selector);
        vault.deposit(DUMMY_PROOF, COMMITMENT_2, 1);
    }

    function test_deposit_capPerAddress() public {
        // Alice hits cap
        vm.prank(alice);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_CAP);
        // Bob can still deposit
        vm.prank(bob);
        vault.deposit(DUMMY_PROOF, COMMITMENT_2, DEPOSIT_AMOUNT);
    }

    // FC-2 / T20: deposit must verify the binding proof. A rejected proof (e.g.
    // committed balance != transferred amount) must revert before any state change.
    function test_deposit_revert_invalidProof() public {
        MockVerifier badDeposit = new MockVerifier(false);
        vm.startPrank(owner);
        vault.proposeVerifier(vault.DEPOSIT(), address(badDeposit));
        vm.warp(block.timestamp + 48 hours + 1);
        vault.acceptVerifier(vault.DEPOSIT());
        vm.stopPrank();

        vm.prank(alice);
        vm.expectRevert(Vault.InvalidProof.selector);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_AMOUNT);

        // No leaf inserted, no USDC pulled, no cumulative increment.
        assertEq(vault.cumulativeDeposits(alice), 0);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    // =========================================================================
    // authorizeBet
    // =========================================================================

    function _depositAndGetRoot() internal returns (bytes32 root) {
        vm.prank(alice);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_AMOUNT);
        root = _currentRoot();
    }

    function _betAuthInputs(bytes32 root) internal pure returns (Vault.BetAuthPublicInputs memory) {
        return Vault.BetAuthPublicInputs({
            merkle_root: root,
            nullifier: NULLIFIER_1,
            new_commitment: COMMITMENT_2,
            bet_amount: 100 * 1e6,
            price: 50_000_000,
            expected_shares: 200_000_000,
            market_id: MARKET_ID,
            outcome_side: 0,
            position_id: POSITION_ID
        });
    }

    function test_authorizeBet_succeeds() public {
        bytes32 root = _depositAndGetRoot();
        vault.authorizeBet(DUMMY_PROOF, _betAuthInputs(root));
        assertTrue(registry.isSpent(NULLIFIER_1));
    }

    function test_authorizeBet_emitsBetAuthorized() public {
        bytes32 root = _depositAndGetRoot();
        Vault.BetAuthPublicInputs memory inputs = _betAuthInputs(root);
        vm.expectEmit(true, false, false, true);
        emit Vault.BetAuthorized(
            NULLIFIER_1,
            MARKET_ID,
            POSITION_ID,
            200_000_000,
            100 * 1e6,
            50_000_000,
            0,           // outcome_side (matches _betAuthInputs)
            COMMITMENT_2
        );
        vault.authorizeBet(DUMMY_PROOF, inputs);
    }

    function test_authorizeBet_storesBetRecord() public {
        bytes32 root = _depositAndGetRoot();
        vault.authorizeBet(DUMMY_PROOF, _betAuthInputs(root));
        (bytes32 mktId, bytes32 condId, bytes32 posId, uint64 shares, uint64 betAmt, uint8 outcomeSide, Vault.BetStatus status,,,,) =
            vault.betRecords(NULLIFIER_1);
        assertEq(mktId, MARKET_ID);
        assertEq(condId, MARKET_ID);
        assertEq(posId, POSITION_ID);
        assertEq(shares, 200_000_000);
        assertEq(betAmt, 100 * 1e6);
        assertEq(outcomeSide, 0);
        assertEq(uint8(status), uint8(Vault.BetStatus.ACTIVE));
    }

    function test_authorizeBet_revert_nullifierSpent() public {
        bytes32 root = _depositAndGetRoot();
        vault.authorizeBet(DUMMY_PROOF, _betAuthInputs(root));
        // Second call should fail: nullifier already spent
        bytes32 root2 = _currentRoot();
        Vault.BetAuthPublicInputs memory inputs2 = _betAuthInputs(root2);
        vm.expectRevert(Vault.NullifierSpent.selector);
        vault.authorizeBet(DUMMY_PROOF, inputs2);
    }

    function test_authorizeBet_revert_unknownRoot() public {
        Vault.BetAuthPublicInputs memory inputs = _betAuthInputs(keccak256("stale_root"));
        vm.expectRevert(Vault.UnknownRoot.selector);
        vault.authorizeBet(DUMMY_PROOF, inputs);
    }

    function test_authorizeBet_revert_invalidProof() public {
        bytes32 root = _depositAndGetRoot();
        betAuthVerifier.setShouldPass(false);
        vm.expectRevert(Vault.InvalidProof.selector);
        vault.authorizeBet(DUMMY_PROOF, _betAuthInputs(root));
    }

    // =========================================================================
    // reportFilled / reportFOKFailure
    // =========================================================================

    function _authorizeBetAndGetNullifier() internal returns (bytes32) {
        bytes32 root = _depositAndGetRoot();
        vault.authorizeBet(DUMMY_PROOF, _betAuthInputs(root));
        return NULLIFIER_1;
    }

    function test_reportFilled_succeeds() public {
        bytes32 null1 = _authorizeBetAndGetNullifier();
        vm.prank(operator);
        vault.reportFilled(null1);
        (,,,,,, Vault.BetStatus status,,,,) = vault.betRecords(null1);
        assertEq(uint8(status), uint8(Vault.BetStatus.FILLED));
    }

    function test_reportFilled_revert_onlyOperator() public {
        bytes32 null1 = _authorizeBetAndGetNullifier();
        vm.prank(attacker);
        vm.expectRevert(Vault.OnlyOperator.selector);
        vault.reportFilled(null1);
    }

    function test_reportFOKFailure_succeeds() public {
        bytes32 null1 = _authorizeBetAndGetNullifier();
        vm.prank(operator);
        vault.reportFOKFailure(null1);
        (,,,,,, Vault.BetStatus status,,,,) = vault.betRecords(null1);
        assertEq(uint8(status), uint8(Vault.BetStatus.FAILED));
    }

    function test_reportFOKFailure_revert_onlyOperator() public {
        bytes32 null1 = _authorizeBetAndGetNullifier();
        vm.prank(attacker);
        vm.expectRevert(Vault.OnlyOperator.selector);
        vault.reportFOKFailure(null1);
    }

    function test_reportFOKFailure_emitsEvent() public {
        bytes32 null1 = _authorizeBetAndGetNullifier();
        vm.prank(operator);
        vm.expectEmit(true, false, false, false);
        emit Vault.FOKFailed(null1);
        vault.reportFOKFailure(null1);
    }

    // =========================================================================
    // creditSettlement
    // =========================================================================

    function _settlementInputs(bytes32 root) internal pure returns (Vault.SettlementPublicInputs memory) {
        return Vault.SettlementPublicInputs({
            merkle_root: root,
            nullifier: NULLIFIER_2,
            new_commitment: COMMITMENT_3,
            nullifier_of_bet: NULLIFIER_1,
            market_id: MARKET_ID,
            // payout_per_share removed — read from pendingCredit[market_id]
            // expected_shares = 200_000_000, payout_per_share = 1 => total_credit = 200_000_000
            total_credit: 200_000_000
        });
    }

    // Set up CTF so resolveMarket(MARKET_ID) succeeds with YES win.
    // numerators[0]/denominator = 1_000_000/1_000_000 = 1 for outcome_side=0 (YES).
    function _setupResolvableMarket() internal {
        uint256[] memory numerators = new uint256[](2);
        numerators[0] = 1_000_000; // YES wins
        numerators[1] = 0;
        ctf.setPayoutNumerators(MARKET_ID, numerators);
        ctf.setPayoutDenominator(MARKET_ID, 1_000_000);
    }

    function _setupFilledBet() internal {
        _authorizeBetAndGetNullifier();
        vm.prank(operator);
        vault.reportFilled(NULLIFIER_1);
    }

    function _setupFilledAndResolvedBet() internal {
        _setupFilledBet();
        _setupResolvableMarket();
        vm.prank(operator);
        vault.resolveMarket(MARKET_ID);
    }

    function test_creditSettlement_succeeds() public {
        _setupFilledAndResolvedBet();
        bytes32 root = _currentRoot();
        vault.creditSettlement(DUMMY_PROOF, _settlementInputs(root));
        assertTrue(registry.isSpent(NULLIFIER_2));
        (,,,,,, Vault.BetStatus status,,,,) = vault.betRecords(NULLIFIER_1);
        assertEq(uint8(status), uint8(Vault.BetStatus.CREDITED));
    }

    function test_creditSettlement_revert_nullifierSpent() public {
        _setupFilledAndResolvedBet();
        bytes32 root = _currentRoot();
        vault.creditSettlement(DUMMY_PROOF, _settlementInputs(root));
        bytes32 root2 = _currentRoot();
        vm.expectRevert(Vault.NullifierSpent.selector);
        vault.creditSettlement(DUMMY_PROOF, _settlementInputs(root2));
    }

    function test_creditSettlement_revert_betNotFound() public {
        vm.prank(alice);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_AMOUNT);
        bytes32 root = _currentRoot();
        Vault.SettlementPublicInputs memory inputs = _settlementInputs(root);
        inputs.nullifier_of_bet = keccak256("nonexistent");
        vm.expectRevert(Vault.BetNotFound.selector);
        vault.creditSettlement(DUMMY_PROOF, inputs);
    }

    function test_creditSettlement_revert_betNotFilled() public {
        // Bet is ACTIVE, not FILLED
        _authorizeBetAndGetNullifier();
        bytes32 root = _currentRoot();
        vm.expectRevert(Vault.BetNotFilled.selector);
        vault.creditSettlement(DUMMY_PROOF, _settlementInputs(root));
    }

    function test_creditSettlement_revert_wrongMarket() public {
        _setupFilledAndResolvedBet();
        bytes32 root = _currentRoot();
        Vault.SettlementPublicInputs memory inputs = _settlementInputs(root);
        inputs.market_id = keccak256("wrong_market");
        vm.expectRevert(Vault.WrongMarket.selector);
        vault.creditSettlement(DUMMY_PROOF, inputs);
    }

    function test_creditSettlement_revert_marketNotResolved() public {
        // Bet is FILLED but resolveMarket was never called
        _setupFilledBet();
        bytes32 root = _currentRoot();
        vm.expectRevert(Vault.MarketNotResolved.selector);
        vault.creditSettlement(DUMMY_PROOF, _settlementInputs(root));
    }

    function test_creditSettlement_revert_invalidProof() public {
        _setupFilledAndResolvedBet();
        bytes32 root = _currentRoot();
        settlementVerifier.setShouldPass(false);
        vm.expectRevert(Vault.InvalidProof.selector);
        vault.creditSettlement(DUMMY_PROOF, _settlementInputs(root));
    }

    function test_creditSettlement_revert_doubleCreditAfterCredited() public {
        _setupFilledAndResolvedBet();
        bytes32 root = _currentRoot();
        vault.creditSettlement(DUMMY_PROOF, _settlementInputs(root));
        // Try to credit again with a new nullifier -- bet status is CREDITED, not FILLED
        bytes32 root2 = _currentRoot();
        Vault.SettlementPublicInputs memory inputs2 = _settlementInputs(root2);
        inputs2.nullifier = keccak256("nullifier_3");
        vm.expectRevert(Vault.BetNotFilled.selector);
        vault.creditSettlement(DUMMY_PROOF, inputs2);
    }

    function test_creditSettlement_succeeds_marketIdAboveBN254P() public {
        // Exercise the BN254 reduction path: when market_id >= BN254_P,
        // resolveMarket writes pendingCredit at the reduced key, so creditSettlement
        // must read from the same reduced key or it always reverts MarketNotResolved.
        uint256 BN254_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
        bytes32 large_market_id = bytes32(BN254_P + 1);

        vm.prank(alice);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_AMOUNT);
        bytes32 root = _currentRoot();

        vault.authorizeBet(DUMMY_PROOF, Vault.BetAuthPublicInputs({
            merkle_root: root,
            nullifier: NULLIFIER_1,
            new_commitment: COMMITMENT_2,
            bet_amount: 100 * 1e6,
            price: 50_000_000,
            expected_shares: 200_000_000,
            market_id: large_market_id,
            outcome_side: 0,
            position_id: POSITION_ID
        }));

        vm.prank(operator);
        vault.reportFilled(NULLIFIER_1);

        uint256[] memory numerators = new uint256[](2);
        numerators[0] = 1_000_000;
        numerators[1] = 0;
        ctf.setPayoutNumerators(large_market_id, numerators);
        ctf.setPayoutDenominator(large_market_id, 1_000_000);
        vm.prank(operator);
        vault.resolveMarket(large_market_id);

        bytes32 root2 = _currentRoot();
        vault.creditSettlement(DUMMY_PROOF, Vault.SettlementPublicInputs({
            merkle_root: root2,
            nullifier: NULLIFIER_2,
            new_commitment: COMMITMENT_3,
            nullifier_of_bet: NULLIFIER_1,
            market_id: large_market_id,
            total_credit: 200_000_000
        }));

        (,,,,,, Vault.BetStatus status,,,,) = vault.betRecords(NULLIFIER_1);
        assertEq(uint8(status), uint8(Vault.BetStatus.CREDITED));
    }

    // =========================================================================
    // resolveMarket
    // =========================================================================

    function test_resolveMarket_succeeds() public {
        _setupResolvableMarket();
        vm.prank(operator);
        vm.expectEmit(true, false, false, true);
        emit Vault.MarketResolved(MARKET_ID, uint64(block.timestamp));
        vault.resolveMarket(MARKET_ID);
        assertEq(vault.pendingCredit(MARKET_ID, 0), 1); // YES side payout = 1
        assertEq(vault.pendingCredit(MARKET_ID, 1), 0); // NO side payout = 0
        assertEq(vault.marketResolvedAt(MARKET_ID), block.timestamp);
    }

    function test_resolveMarket_revert_conditionNotResolved() public {
        vm.prank(operator);
        vm.expectRevert(Vault.ConditionNotResolved.selector);
        vault.resolveMarket(MARKET_ID);
    }

    function test_resolveMarket_revert_notNA_market() public {
        // All-zero numerators = N/A; resolveMarket should revert NotNA
        uint256[] memory numerators = new uint256[](2);
        numerators[0] = 0;
        numerators[1] = 0;
        ctf.setPayoutNumerators(MARKET_ID, numerators);
        ctf.setPayoutDenominator(MARKET_ID, 1_000_000);
        vm.prank(operator);
        vm.expectRevert(Vault.NotNA.selector);
        vault.resolveMarket(MARKET_ID);
    }

    function test_resolveMarket_revert_alreadyResolved() public {
        _setupResolvableMarket();
        vm.prank(operator);
        vault.resolveMarket(MARKET_ID);
        // Second call should revert
        vm.prank(operator);
        vm.expectRevert(Vault.MarketAlreadyResolved.selector);
        vault.resolveMarket(MARKET_ID);
    }

    function test_resolveMarket_revert_onlyOperator() public {
        _setupResolvableMarket();
        vm.prank(attacker);
        vm.expectRevert(Vault.OnlyOperator.selector);
        vault.resolveMarket(MARKET_ID);
    }

    // =========================================================================
    // withdraw
    // =========================================================================

    function _withdrawInputs(bytes32 root, bytes32 recipientHash, bytes32 newCommitment)
        internal
        pure
        returns (Vault.WithdrawalPublicInputs memory)
    {
        return Vault.WithdrawalPublicInputs({
            merkle_root: root,
            nullifier: NULLIFIER_2,
            withdrawal_amount: 500 * 1e6,
            recipient_hash: recipientHash,
            new_commitment: newCommitment
        });
    }

    function _recipientHash(address addr) internal view returns (bytes32) {
        return tree.hashTwo(bytes32(uint256(uint160(addr))), bytes32(0));
    }

    function test_withdraw_succeeds() public {
        vm.prank(alice);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_AMOUNT);
        bytes32 root = _currentRoot();
        bytes32 rHash = _recipientHash(recipient);
        bytes32 nextCommitment = COMMITMENT_2;
        uint256 balBefore = usdc.balanceOf(recipient);
        vault.withdraw(DUMMY_PROOF, _withdrawInputs(root, rHash, nextCommitment), recipient);
        assertEq(usdc.balanceOf(recipient) - balBefore, 500 * 1e6);
        assertTrue(registry.isSpent(NULLIFIER_2));
        assertEq(_currentRoot(), tree.recentRoots(tree.currentRootIndex()));
    }

    function test_withdraw_emitsEvent() public {
        vm.prank(alice);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_AMOUNT);
        bytes32 root = _currentRoot();
        bytes32 rHash = _recipientHash(recipient);
        bytes32 nextCommitment = COMMITMENT_2;
        vm.expectEmit(true, false, false, true);
        emit Vault.Withdrawn(NULLIFIER_2, recipient, 500 * 1e6, nextCommitment);
        vault.withdraw(DUMMY_PROOF, _withdrawInputs(root, rHash, nextCommitment), recipient);
    }

    function test_withdraw_partial_insertsRemainderCommitment() public {
        vm.prank(alice);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_AMOUNT);
        bytes32 root = _currentRoot();
        bytes32 rHash = _recipientHash(recipient);
        bytes32 nextCommitment = COMMITMENT_2;
        uint32 rootIndexBefore = tree.currentRootIndex();

        vault.withdraw(DUMMY_PROOF, _withdrawInputs(root, rHash, nextCommitment), recipient);

        assertEq(tree.currentRootIndex(), rootIndexBefore + 1);
        assertEq(_currentRoot(), tree.recentRoots(tree.currentRootIndex()));
    }

    function test_withdraw_full_skipsRemainderInsert() public {
        vm.prank(alice);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_AMOUNT);
        bytes32 root = _currentRoot();
        bytes32 rHash = _recipientHash(recipient);
        Vault.WithdrawalPublicInputs memory inputs = Vault.WithdrawalPublicInputs({
            merkle_root: root,
            nullifier: NULLIFIER_2,
            withdrawal_amount: uint64(DEPOSIT_AMOUNT),
            recipient_hash: rHash,
            new_commitment: bytes32(0)
        });
        uint32 rootIndexBefore = tree.currentRootIndex();
        uint256 balBefore = usdc.balanceOf(recipient);

        vault.withdraw(DUMMY_PROOF, inputs, recipient);

        assertEq(usdc.balanceOf(recipient) - balBefore, DEPOSIT_AMOUNT);
        assertEq(tree.currentRootIndex(), rootIndexBefore);
    }

    function test_withdraw_revert_nullifierSpent() public {
        vm.prank(alice);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_AMOUNT);
        bytes32 root = _currentRoot();
        bytes32 rHash = _recipientHash(recipient);
        vault.withdraw(DUMMY_PROOF, _withdrawInputs(root, rHash, COMMITMENT_2), recipient);
        bytes32 root2 = _currentRoot();
        vm.expectRevert(Vault.NullifierSpent.selector);
        vault.withdraw(DUMMY_PROOF, _withdrawInputs(root2, rHash, COMMITMENT_3), recipient);
    }

    function test_withdraw_revert_unknownRoot() public {
        bytes32 rHash = _recipientHash(recipient);
        vm.expectRevert(Vault.UnknownRoot.selector);
        vault.withdraw(DUMMY_PROOF, _withdrawInputs(keccak256("stale"), rHash, COMMITMENT_2), recipient);
    }

    function test_withdraw_revert_badRecipient() public {
        vm.prank(alice);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_AMOUNT);
        bytes32 root = _currentRoot();
        bytes32 rHash = _recipientHash(recipient);
        // Supply bob's address instead of recipient
        vm.expectRevert(Vault.BadRecipient.selector);
        vault.withdraw(DUMMY_PROOF, _withdrawInputs(root, rHash, COMMITMENT_2), bob);
    }

    function test_withdraw_revert_invalidProof() public {
        vm.prank(alice);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_AMOUNT);
        bytes32 root = _currentRoot();
        bytes32 rHash = _recipientHash(recipient);
        withdrawalVerifier.setShouldPass(false);
        vm.expectRevert(Vault.InvalidProof.selector);
        vault.withdraw(DUMMY_PROOF, _withdrawInputs(root, rHash, COMMITMENT_2), recipient);
    }

    // =========================================================================
    // betCancellationCredit
    // =========================================================================

    function _betCancelInputs(bytes32 root) internal pure returns (Vault.BetCancelPublicInputs memory) {
        return Vault.BetCancelPublicInputs({
            merkle_root: root,
            nullifier: NULLIFIER_2,
            new_commitment: COMMITMENT_3,
            nullifier_of_bet: NULLIFIER_1
        });
    }

    function _setupFailedBet() internal {
        _authorizeBetAndGetNullifier();
        vm.prank(operator);
        vault.reportFOKFailure(NULLIFIER_1);
    }

    function test_betCancellationCredit_succeeds() public {
        _setupFailedBet();
        bytes32 root = _currentRoot();
        vault.betCancellationCredit(DUMMY_PROOF, _betCancelInputs(root));
        assertTrue(registry.isSpent(NULLIFIER_2));
        (,,,,,, Vault.BetStatus status,,,,) = vault.betRecords(NULLIFIER_1);
        assertEq(uint8(status), uint8(Vault.BetStatus.CANCELLED_CREDITED));
    }

    function test_betCancellationCredit_revert_alreadyCredited() public {
        _setupFailedBet();
        bytes32 root = _currentRoot();
        vault.betCancellationCredit(DUMMY_PROOF, _betCancelInputs(root));
        // Status is now CANCELLED_CREDITED, not FAILED
        bytes32 root2 = _currentRoot();
        Vault.BetCancelPublicInputs memory inputs2 = _betCancelInputs(root2);
        inputs2.nullifier = keccak256("null_3");
        vm.expectRevert(Vault.BetNotFailed.selector);
        vault.betCancellationCredit(DUMMY_PROOF, inputs2);
    }

    function test_betCancellationCredit_revert_betNotFailed() public {
        // Bet is ACTIVE, not FAILED
        _authorizeBetAndGetNullifier();
        bytes32 root = _currentRoot();
        vm.expectRevert(Vault.BetNotFailed.selector);
        vault.betCancellationCredit(DUMMY_PROOF, _betCancelInputs(root));
    }

    function test_betCancellationCredit_revert_invalidProof() public {
        _setupFailedBet();
        bytes32 root = _currentRoot();
        betCancelVerifier.setShouldPass(false);
        vm.expectRevert(Vault.InvalidProof.selector);
        vault.betCancellationCredit(DUMMY_PROOF, _betCancelInputs(root));
    }

    // =========================================================================
    // naCancellationCredit
    // =========================================================================

    function _naCancelInputs(bytes32 root) internal pure returns (Vault.NACancelPublicInputs memory) {
        return Vault.NACancelPublicInputs({
            merkle_root: root,
            nullifier: NULLIFIER_2,
            new_commitment: COMMITMENT_3,
            nullifier_of_bet: NULLIFIER_1,
            market_id: MARKET_ID
        });
    }

    function _setupNAMarket() internal {
        _authorizeBetAndGetNullifier();
        // Set all-zero numerators with non-zero denominator (N/A resolution)
        uint256[] memory numerators = new uint256[](2);
        numerators[0] = 0;
        numerators[1] = 0;
        ctf.setPayoutNumerators(MARKET_ID, numerators);
        ctf.setPayoutDenominator(MARKET_ID, 1_000_000); // C2: denominator > 0 confirms condition resolved
    }

    function test_naCancellationCredit_succeeds() public {
        _setupNAMarket();
        bytes32 root = _currentRoot();
        vault.naCancellationCredit(DUMMY_PROOF, _naCancelInputs(root));
        assertTrue(registry.isSpent(NULLIFIER_2));
        (,,,,,, Vault.BetStatus status,,,,) = vault.betRecords(NULLIFIER_1);
        assertEq(uint8(status), uint8(Vault.BetStatus.CANCELLED_CREDITED));
    }

    function test_naCancellationCredit_revert_notNA() public {
        _authorizeBetAndGetNullifier();
        // Non-zero numerators = not N/A; denominator must be set so C2 passes
        uint256[] memory numerators = new uint256[](2);
        numerators[0] = 0;
        numerators[1] = 1_000_000; // YES wins
        ctf.setPayoutNumerators(MARKET_ID, numerators);
        ctf.setPayoutDenominator(MARKET_ID, 1_000_000);
        bytes32 root = _currentRoot();
        vm.expectRevert(Vault.NotNA.selector);
        vault.naCancellationCredit(DUMMY_PROOF, _naCancelInputs(root));
    }

    function test_naCancellationCredit_revert_nullifierSpent() public {
        _setupNAMarket();
        bytes32 root = _currentRoot();
        vault.naCancellationCredit(DUMMY_PROOF, _naCancelInputs(root));
        // Second call with the same nullifier (NULLIFIER_2) → NullifierSpent
        bytes32 root2 = _currentRoot();
        vm.expectRevert(Vault.NullifierSpent.selector);
        vault.naCancellationCredit(DUMMY_PROOF, _naCancelInputs(root2));
    }

    function test_naCancellationCredit_revert_wrongMarket() public {
        _setupNAMarket();
        bytes32 root = _currentRoot();
        Vault.NACancelPublicInputs memory inputs = _naCancelInputs(root);
        inputs.market_id = keccak256("wrong");
        vm.expectRevert(Vault.WrongMarket.selector);
        vault.naCancellationCredit(DUMMY_PROOF, inputs);
    }

    function test_naCancellationCredit_revert_invalidProof() public {
        _setupNAMarket();
        bytes32 root = _currentRoot();
        cancelCreditVerifier.setShouldPass(false);
        vm.expectRevert(Vault.InvalidProof.selector);
        vault.naCancellationCredit(DUMMY_PROOF, _naCancelInputs(root));
    }

    // =========================================================================
    // Merkle root window edge cases
    // =========================================================================

    function test_oldRootStillAccepted() public {
        // Store the initial root, then insert 29 more leaves (total 30 in window)
        // The initial root should still be accepted
        bytes32 initialRoot = tree.recentRoots(0);

        for (uint32 i = 0; i < 29; i++) {
            vm.prank(alice);
            vault.deposit(DUMMY_PROOF, bytes32(uint256(i + 1)), DEPOSIT_CAP / 30);
        }
        // Initial root (slot 0) is still in the window
        assertTrue(tree.isKnownRoot(initialRoot));
    }

    function test_evictedRootRejected() public {
        // Need to advance 30 leaves so the initial root gets evicted
        // but Alice cap is 50k. Use multiple addresses.
        vm.prank(alice);
        vault.deposit(DUMMY_PROOF, COMMITMENT_1, DEPOSIT_AMOUNT);
        bytes32 firstLeafRoot = _currentRoot();

        // Insert 30 more leaves with different users to evict firstLeafRoot.
        // firstLeafRoot is at slot 1; after 30 more inserts the ring wraps
        // and slot 1 is overwritten (slots: 2..29, 0, 1).
        for (uint256 i = 0; i < 30; i++) {
            address user = address(uint160(0x1000 + i));
            usdc.mint(user, DEPOSIT_AMOUNT);
            vm.prank(user);
            usdc.approve(address(vault), DEPOSIT_AMOUNT);
            vm.prank(user);
            vault.deposit(DUMMY_PROOF, bytes32(uint256(i + 100)), DEPOSIT_AMOUNT);
        }

        // firstLeafRoot is now evicted (30 inserts later)
        assertFalse(tree.isKnownRoot(firstLeafRoot));
        Vault.BetAuthPublicInputs memory inputs = _betAuthInputs(firstLeafRoot);
        inputs.nullifier = keccak256("fresh_nullifier");
        vm.expectRevert(Vault.UnknownRoot.selector);
        vault.authorizeBet(DUMMY_PROOF, inputs);
    }

    // =========================================================================
    // Status transition safety
    // =========================================================================

    function test_statusTransition_activeToFailed() public {
        _authorizeBetAndGetNullifier();
        vm.prank(operator);
        vault.reportFOKFailure(NULLIFIER_1);
        _setupFailedBetCancellation();
        (,,,,,, Vault.BetStatus status,,,,) = vault.betRecords(NULLIFIER_1);
        assertEq(uint8(status), uint8(Vault.BetStatus.CANCELLED_CREDITED));
    }

    function _setupFailedBetCancellation() internal {
        bytes32 root = _currentRoot();
        vault.betCancellationCredit(DUMMY_PROOF, _betCancelInputs(root));
    }

    function test_cannotDoubleCreditAfterCancelledCredited() public {
        _setupFailedBet();
        bytes32 root = _currentRoot();
        vault.betCancellationCredit(DUMMY_PROOF, _betCancelInputs(root));

        bytes32 root2 = _currentRoot();
        Vault.BetCancelPublicInputs memory inputs2 = _betCancelInputs(root2);
        inputs2.nullifier = keccak256("null_3");
        // status is now CANCELLED_CREDITED, not FAILED -> revert BetNotFailed
        vm.expectRevert(Vault.BetNotFailed.selector);
        vault.betCancellationCredit(DUMMY_PROOF, inputs2);
    }

    // =========================================================================
    // Admin
    // =========================================================================

    function test_proposeVerifier_onlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        vault.proposeVerifier(0, address(betAuthVerifier));
    }

    function test_proposeVerifier_rejectsZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(Vault.ZeroAddress.selector);
        vault.proposeVerifier(0, address(0));
    }

    function test_acceptVerifier_rejectsBeforeTimelock() public {
        address newVerifier = address(new MockVerifier(true));
        vm.prank(owner);
        vault.proposeVerifier(0, newVerifier);
        vm.prank(owner);
        vm.expectRevert(Vault.VerifierTimelockActive.selector);
        vault.acceptVerifier(0);
    }

    function test_setSigningLayerOperator_onlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        vault.setSigningLayerOperator(attacker);
    }

    // =========================================================================
    // adminCancelBet
    // =========================================================================

    function test_adminCancelBet_happyPath() public {
        _authorizeBetAndGetNullifier();
        vm.warp(block.timestamp + vault.adminCancelTimelock() + 1);
        vm.prank(owner);
        vm.expectEmit(true, false, false, false);
        emit Vault.AdminBetCancelled(NULLIFIER_1);
        vault.adminCancelBet(NULLIFIER_1);
        (,,,,,, Vault.BetStatus status,,,,) = vault.betRecords(NULLIFIER_1);
        assertEq(uint8(status), uint8(Vault.BetStatus.FAILED));
    }

    function test_adminCancelBet_revertBeforeTimelock() public {
        _authorizeBetAndGetNullifier();
        vm.warp(block.timestamp + vault.adminCancelTimelock() - 1);
        vm.prank(owner);
        vm.expectRevert(Vault.BetTimeoutNotElapsed.selector);
        vault.adminCancelBet(NULLIFIER_1);
    }

    function test_adminCancelBet_revertNotActive() public {
        _authorizeBetAndGetNullifier();
        vm.prank(operator);
        vault.reportFilled(NULLIFIER_1);
        vm.warp(block.timestamp + vault.adminCancelTimelock() + 1);
        vm.prank(owner);
        vm.expectRevert(Vault.BetNotActive.selector);
        vault.adminCancelBet(NULLIFIER_1);
    }

    function test_adminCancelBet_revertNotOwner() public {
        _authorizeBetAndGetNullifier();
        vm.warp(block.timestamp + vault.adminCancelTimelock() + 1);
        vm.prank(attacker);
        vm.expectRevert();
        vault.adminCancelBet(NULLIFIER_1);
    }

    // =========================================================================
    // FC-1: reportSold + closePosition (pre-settlement secondary sale)
    // =========================================================================

    uint64 constant EXPECTED_SHARES = 200_000_000; // matches _betAuthInputs
    uint64 constant CLOSE_PROCEEDS  = 80 * 1e6;

    function _closeInputs(bytes32 root) internal pure returns (Vault.ClosePublicInputs memory) {
        return Vault.ClosePublicInputs({
            merkle_root: root,
            nullifier: NULLIFIER_2,
            new_commitment: COMMITMENT_3,
            nullifier_of_bet: NULLIFIER_1
        });
    }

    function test_reportSold_succeeds_setsClosing() public {
        _setupFilledBet();
        vm.prank(operator);
        vm.expectEmit(true, false, false, true);
        emit Vault.BetSold(NULLIFIER_1, EXPECTED_SHARES, CLOSE_PROCEEDS);
        vault.reportSold(NULLIFIER_1, EXPECTED_SHARES, CLOSE_PROCEEDS);
        (,,, uint64 shares,,, Vault.BetStatus status, uint64 proceeds, uint64 sold,,) = vault.betRecords(NULLIFIER_1);
        assertEq(uint8(status), uint8(Vault.BetStatus.CLOSING));
        assertEq(proceeds, CLOSE_PROCEEDS);
        assertEq(sold, EXPECTED_SHARES);
        assertEq(shares, EXPECTED_SHARES);
    }

    function test_reportSold_revert_onlyOperator() public {
        _setupFilledBet();
        vm.prank(attacker);
        vm.expectRevert(Vault.OnlyOperator.selector);
        vault.reportSold(NULLIFIER_1, EXPECTED_SHARES, CLOSE_PROCEEDS);
    }

    function test_reportSold_revert_notFilled() public {
        _authorizeBetAndGetNullifier(); // ACTIVE, not FILLED
        vm.prank(operator);
        vm.expectRevert(Vault.BetNotFilled.selector);
        vault.reportSold(NULLIFIER_1, EXPECTED_SHARES, CLOSE_PROCEEDS);
    }

    function test_reportSold_revert_invalidShares_zero() public {
        _setupFilledBet();
        vm.prank(operator);
        vm.expectRevert(Vault.InvalidSoldShares.selector);
        vault.reportSold(NULLIFIER_1, 0, CLOSE_PROCEEDS);
    }

    function test_reportSold_revert_invalidShares_tooMany() public {
        _setupFilledBet();
        vm.prank(operator);
        vm.expectRevert(Vault.InvalidSoldShares.selector);
        vault.reportSold(NULLIFIER_1, EXPECTED_SHARES + 1, CLOSE_PROCEEDS);
    }

    // Settlement race: a resolved market settles, it cannot be closed.
    function test_reportSold_revert_resolvedMarket() public {
        _setupFilledAndResolvedBet();
        vm.prank(operator);
        vm.expectRevert(Vault.CannotCloseResolvedMarket.selector);
        vault.reportSold(NULLIFIER_1, EXPECTED_SHARES, CLOSE_PROCEEDS);
    }

    function test_closePosition_fullClose_credited() public {
        _setupFilledBet();
        vm.prank(operator);
        vault.reportSold(NULLIFIER_1, EXPECTED_SHARES, CLOSE_PROCEEDS);
        bytes32 root = _currentRoot();

        vm.expectEmit(true, false, false, true);
        emit Vault.PositionClosed(NULLIFIER_2, NULLIFIER_1, COMMITMENT_3, true);
        vault.closePosition(DUMMY_PROOF, _closeInputs(root));

        assertTrue(registry.isSpent(NULLIFIER_2));
        (,,, uint64 shares,,, Vault.BetStatus status, uint64 proceeds, uint64 sold,,) = vault.betRecords(NULLIFIER_1);
        assertEq(uint8(status), uint8(Vault.BetStatus.CLOSED_CREDITED));
        assertEq(shares, EXPECTED_SHARES); // unchanged on full close
        assertEq(proceeds, 0);
        assertEq(sold, 0);
    }

    function test_closePosition_partialClose_returnsToFilled() public {
        _setupFilledBet();
        uint64 soldShares = 120_000_000; // < EXPECTED_SHARES
        vm.prank(operator);
        vault.reportSold(NULLIFIER_1, soldShares, CLOSE_PROCEEDS);
        bytes32 root = _currentRoot();

        vm.expectEmit(true, false, false, true);
        emit Vault.PositionClosed(NULLIFIER_2, NULLIFIER_1, COMMITMENT_3, false);
        vault.closePosition(DUMMY_PROOF, _closeInputs(root));

        (,,, uint64 shares,,, Vault.BetStatus status, uint64 proceeds, uint64 sold,,) = vault.betRecords(NULLIFIER_1);
        assertEq(uint8(status), uint8(Vault.BetStatus.FILLED));
        assertEq(shares, EXPECTED_SHARES - soldShares); // reduced
        assertEq(proceeds, 0);
        assertEq(sold, 0);
    }

    function test_closePosition_revert_notClosing() public {
        _setupFilledBet(); // FILLED, no reportSold
        bytes32 root = _currentRoot();
        vm.expectRevert(Vault.BetNotClosing.selector);
        vault.closePosition(DUMMY_PROOF, _closeInputs(root));
    }

    // Double-close: after a full close the record is terminal; a second close with a
    // fresh note nullifier reverts on the CLOSING guard (no second credit).
    function test_closePosition_revert_doubleClose() public {
        _setupFilledBet();
        vm.prank(operator);
        vault.reportSold(NULLIFIER_1, EXPECTED_SHARES, CLOSE_PROCEEDS);
        bytes32 root = _currentRoot();
        vault.closePosition(DUMMY_PROOF, _closeInputs(root));

        Vault.ClosePublicInputs memory again = Vault.ClosePublicInputs({
            merkle_root: _currentRoot(),
            nullifier: keccak256("nullifier_fresh"),
            new_commitment: keccak256("commitment_fresh"),
            nullifier_of_bet: NULLIFIER_1
        });
        vm.expectRevert(Vault.BetNotClosing.selector);
        vault.closePosition(DUMMY_PROOF, again);
    }

    // Partial close, then the remainder settles normally against reduced shares.
    function test_closePosition_partialThenSettleRemainder() public {
        _setupFilledBet();
        uint64 soldShares = 120_000_000;
        vm.prank(operator);
        vault.reportSold(NULLIFIER_1, soldShares, CLOSE_PROCEEDS);
        vault.closePosition(DUMMY_PROOF, _closeInputs(_currentRoot()));

        // Now resolve the market and settle the remaining 80M shares.
        _setupResolvableMarket();
        vm.prank(operator);
        vault.resolveMarket(MARKET_ID);

        uint64 remaining = EXPECTED_SHARES - soldShares; // 80_000_000
        Vault.SettlementPublicInputs memory s = Vault.SettlementPublicInputs({
            merkle_root: _currentRoot(),
            nullifier: keccak256("nullifier_settle"),
            new_commitment: keccak256("commitment_settle"),
            nullifier_of_bet: NULLIFIER_1,
            market_id: MARKET_ID,
            total_credit: remaining // payout_per_share = 1
        });
        vault.creditSettlement(DUMMY_PROOF, s);
        (,,,,,, Vault.BetStatus status,,,,) = vault.betRecords(NULLIFIER_1);
        assertEq(uint8(status), uint8(Vault.BetStatus.CREDITED));
    }

    function test_closePosition_revert_nullifierSpent() public {
        _setupFilledBet();
        vm.prank(operator);
        vault.reportSold(NULLIFIER_1, EXPECTED_SHARES, CLOSE_PROCEEDS);
        bytes32 root = _currentRoot();
        vault.closePosition(DUMMY_PROOF, _closeInputs(root));
        // Re-using the same note nullifier must revert (it is already spent).
        Vault.ClosePublicInputs memory replay = _closeInputs(_currentRoot());
        vm.expectRevert(Vault.NullifierSpent.selector);
        vault.closePosition(DUMMY_PROOF, replay);
    }

    // ─── FC-4: native limit orders (RESTING / partial-fill credit) ───────────────

    uint64 constant PF_FILLED_SHARES = 120_000_000; // < EXPECTED_SHARES (200_000_000)
    uint64 constant PF_SPENT_AMOUNT  = 60 * 1e6;    // < bet_amount (100 * 1e6); refund = 40 * 1e6

    function _partialInputs(bytes32 root) internal pure returns (Vault.PartialFillPublicInputs memory) {
        return Vault.PartialFillPublicInputs({
            merkle_root: root,
            nullifier: NULLIFIER_2,
            new_commitment: COMMITMENT_3,
            nullifier_of_bet: NULLIFIER_1
        });
    }

    function test_reportResting_succeeds() public {
        _authorizeBetAndGetNullifier(); // ACTIVE
        vm.prank(operator);
        vm.expectEmit(true, false, false, false);
        emit Vault.BetResting(NULLIFIER_1);
        vault.reportResting(NULLIFIER_1);
        (,,,,,, Vault.BetStatus status,,,,) = vault.betRecords(NULLIFIER_1);
        assertEq(uint8(status), uint8(Vault.BetStatus.RESTING));
    }

    function test_reportResting_revert_onlyOperator() public {
        _authorizeBetAndGetNullifier();
        vm.prank(attacker);
        vm.expectRevert(Vault.OnlyOperator.selector);
        vault.reportResting(NULLIFIER_1);
    }

    function test_reportResting_revert_notActive() public {
        _setupFilledBet(); // FILLED, not ACTIVE
        vm.prank(operator);
        vm.expectRevert(Vault.BetNotActive.selector);
        vault.reportResting(NULLIFIER_1);
    }

    function test_reportPartialFill_succeeds_fromActive() public {
        _authorizeBetAndGetNullifier(); // ACTIVE
        vm.prank(operator);
        vm.expectEmit(true, false, false, true);
        emit Vault.BetPartialFilled(NULLIFIER_1, PF_FILLED_SHARES, PF_SPENT_AMOUNT);
        vault.reportPartialFill(NULLIFIER_1, PF_FILLED_SHARES, PF_SPENT_AMOUNT);
        (,,,,,, Vault.BetStatus status,,, uint64 filled, uint64 spent) = vault.betRecords(NULLIFIER_1);
        assertEq(uint8(status), uint8(Vault.BetStatus.PARTIAL_FILLED));
        assertEq(filled, PF_FILLED_SHARES);
        assertEq(spent, PF_SPENT_AMOUNT);
    }

    function test_reportPartialFill_succeeds_fromResting() public {
        _authorizeBetAndGetNullifier();
        vm.prank(operator);
        vault.reportResting(NULLIFIER_1);
        vm.prank(operator);
        vault.reportPartialFill(NULLIFIER_1, PF_FILLED_SHARES, PF_SPENT_AMOUNT);
        (,,,,,, Vault.BetStatus status,,,,) = vault.betRecords(NULLIFIER_1);
        assertEq(uint8(status), uint8(Vault.BetStatus.PARTIAL_FILLED));
    }

    function test_reportPartialFill_revert_onlyOperator() public {
        _authorizeBetAndGetNullifier();
        vm.prank(attacker);
        vm.expectRevert(Vault.OnlyOperator.selector);
        vault.reportPartialFill(NULLIFIER_1, PF_FILLED_SHARES, PF_SPENT_AMOUNT);
    }

    // A terminal/credited state (here FILLED) is neither ACTIVE nor RESTING.
    function test_reportPartialFill_revert_badStatus() public {
        _setupFilledBet(); // FILLED
        vm.prank(operator);
        vm.expectRevert(Vault.BetNotPartialFillable.selector);
        vault.reportPartialFill(NULLIFIER_1, PF_FILLED_SHARES, PF_SPENT_AMOUNT);
    }

    function test_reportPartialFill_revert_invalidFilledShares_zero() public {
        _authorizeBetAndGetNullifier();
        vm.prank(operator);
        vm.expectRevert(Vault.InvalidFilledShares.selector);
        vault.reportPartialFill(NULLIFIER_1, 0, PF_SPENT_AMOUNT);
    }

    function test_reportPartialFill_revert_invalidFilledShares_tooMany() public {
        _authorizeBetAndGetNullifier();
        vm.prank(operator);
        vm.expectRevert(Vault.InvalidFilledShares.selector);
        vault.reportPartialFill(NULLIFIER_1, EXPECTED_SHARES + 1, PF_SPENT_AMOUNT);
    }

    function test_reportPartialFill_revert_invalidSpentAmount_zero() public {
        _authorizeBetAndGetNullifier();
        vm.prank(operator);
        vm.expectRevert(Vault.InvalidSpentAmount.selector);
        vault.reportPartialFill(NULLIFIER_1, PF_FILLED_SHARES, 0);
    }

    function test_reportPartialFill_revert_invalidSpentAmount_tooMany() public {
        _authorizeBetAndGetNullifier();
        vm.prank(operator);
        vm.expectRevert(Vault.InvalidSpentAmount.selector);
        vault.reportPartialFill(NULLIFIER_1, PF_FILLED_SHARES, uint64(100 * 1e6) + 1);
    }

    function test_partialFillCredit_succeeds_normalizesToFilled() public {
        _authorizeBetAndGetNullifier();
        vm.prank(operator);
        vault.reportPartialFill(NULLIFIER_1, PF_FILLED_SHARES, PF_SPENT_AMOUNT);
        bytes32 root = _currentRoot();

        vm.expectEmit(true, false, false, true);
        emit Vault.PartialFillCredited(NULLIFIER_2, NULLIFIER_1, COMMITMENT_3);
        vault.partialFillCredit(DUMMY_PROOF, _partialInputs(root));

        assertTrue(registry.isSpent(NULLIFIER_2));
        (,,, uint64 shares, uint64 amount,, Vault.BetStatus status,,, uint64 filled, uint64 spent) =
            vault.betRecords(NULLIFIER_1);
        assertEq(uint8(status), uint8(Vault.BetStatus.FILLED));
        assertEq(shares, PF_FILLED_SHARES);   // normalized to the shares actually bought
        assertEq(amount, PF_SPENT_AMOUNT);    // normalized to the amount actually spent
        assertEq(filled, 0);
        assertEq(spent, 0);
    }

    function test_partialFillCredit_revert_notPartialFilled() public {
        _setupFilledBet(); // FILLED, no reportPartialFill
        bytes32 root = _currentRoot();
        vm.expectRevert(Vault.BetNotPartialFilled.selector);
        vault.partialFillCredit(DUMMY_PROOF, _partialInputs(root));
    }

    function test_partialFillCredit_revert_nullifierSpent() public {
        _authorizeBetAndGetNullifier();
        vm.prank(operator);
        vault.reportPartialFill(NULLIFIER_1, PF_FILLED_SHARES, PF_SPENT_AMOUNT);
        vault.partialFillCredit(DUMMY_PROOF, _partialInputs(_currentRoot()));
        // Replaying the same note nullifier must revert (already spent).
        Vault.PartialFillPublicInputs memory replay = _partialInputs(_currentRoot());
        vm.expectRevert(Vault.NullifierSpent.selector);
        vault.partialFillCredit(DUMMY_PROOF, replay);
    }

    // A legitimately resting limit order is exempt from adminCancelBet.
    function test_adminCancelBet_restingExempt() public {
        _authorizeBetAndGetNullifier();
        vm.prank(operator);
        vault.reportResting(NULLIFIER_1);
        vm.warp(block.timestamp + vault.adminCancelTimelock() + 1);
        vm.prank(owner);
        vm.expectRevert(Vault.BetNotActive.selector);
        vault.adminCancelBet(NULLIFIER_1);
    }

    // After partial credit normalizes the record to FILLED, settlement works on the
    // reduced (filled) shares exactly as for a normal filled bet.
    function test_partialFillCredit_thenSettleRemainder() public {
        _authorizeBetAndGetNullifier();
        vm.prank(operator);
        vault.reportPartialFill(NULLIFIER_1, PF_FILLED_SHARES, PF_SPENT_AMOUNT);
        vault.partialFillCredit(DUMMY_PROOF, _partialInputs(_currentRoot()));

        _setupResolvableMarket();
        vm.prank(operator);
        vault.resolveMarket(MARKET_ID);

        Vault.SettlementPublicInputs memory s = Vault.SettlementPublicInputs({
            merkle_root: _currentRoot(),
            nullifier: keccak256("nullifier_settle_pf"),
            new_commitment: keccak256("commitment_settle_pf"),
            nullifier_of_bet: NULLIFIER_1,
            market_id: MARKET_ID,
            total_credit: PF_FILLED_SHARES // payout_per_share = 1
        });
        vault.creditSettlement(DUMMY_PROOF, s);
        (,,,,,, Vault.BetStatus status,,,,) = vault.betRecords(NULLIFIER_1);
        assertEq(uint8(status), uint8(Vault.BetStatus.CREDITED));
    }
}
