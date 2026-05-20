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

contract VaultTest is Test {
    Vault public vault;
    CommitmentMerkleTree public tree;
    NullifierRegistry public registry;
    MockVerifier public betAuthVerifier;
    MockVerifier public settlementVerifier;
    MockVerifier public withdrawalVerifier;
    MockVerifier public betCancelVerifier;
    MockVerifier public cancelCreditVerifier;
    MockPoseidonT3 public poseidon;
    MockUSDC public usdc;
    MockCTF public ctf;

    address public owner = address(0x0wner);
    address public operator = address(0x0P);
    address public depositWallet = address(0xDEP);
    address public alice = address(0xA1);
    address public bob = address(0xB0B);
    address public attacker = address(0xBAD);
    address public recipient = address(0xREC);

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
        ctf = new MockCTF();

        // Deploy infrastructure with vault address = this contract initially,
        // then we re-deploy with the actual vault address
        address predictedVault = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 3);

        registry = new NullifierRegistry(predictedVault);
        tree = new CommitmentMerkleTree(predictedVault, address(poseidon));

        vault = new Vault(
            address(usdc),
            address(tree),
            address(registry),
            address(0), // onramp (not tested)
            address(0), // offramp (not tested)
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

        // Wire verifiers
        vm.startPrank(owner);
        vault.setVerifier(vault.BET_AUTH(), address(betAuthVerifier));
        vault.setVerifier(vault.SETTLEMENT_CREDIT(), address(settlementVerifier));
        vault.setVerifier(vault.WITHDRAWAL(), address(withdrawalVerifier));
        vault.setVerifier(vault.BET_CANCEL(), address(betCancelVerifier));
        vault.setVerifier(vault.CANCEL_CREDIT(), address(cancelCreditVerifier));
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
        vault.deposit(COMMITMENT_1, DEPOSIT_AMOUNT);
        assertEq(vault.cumulativeDeposits(alice), DEPOSIT_AMOUNT);
        assertEq(usdc.balanceOf(address(vault)), DEPOSIT_AMOUNT);
    }

    function test_deposit_emitsEvent() public {
        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit Vault.Deposited(alice, COMMITMENT_1, DEPOSIT_AMOUNT);
        vault.deposit(COMMITMENT_1, DEPOSIT_AMOUNT);
    }

    function test_deposit_exactCapSucceeds() public {
        vm.prank(alice);
        vault.deposit(COMMITMENT_1, DEPOSIT_CAP);
    }

    function test_deposit_revert_capExceeded() public {
        vm.prank(alice);
        vault.deposit(COMMITMENT_1, DEPOSIT_CAP);
        vm.prank(alice);
        vm.expectRevert(Vault.DepositCapExceeded.selector);
        vault.deposit(COMMITMENT_2, 1);
    }

    function test_deposit_capPerAddress() public {
        // Alice hits cap
        vm.prank(alice);
        vault.deposit(COMMITMENT_1, DEPOSIT_CAP);
        // Bob can still deposit
        vm.prank(bob);
        vault.deposit(COMMITMENT_2, DEPOSIT_AMOUNT);
    }

    // =========================================================================
    // authorizeBet
    // =========================================================================

    function _depositAndGetRoot() internal returns (bytes32 root) {
        vm.prank(alice);
        vault.deposit(COMMITMENT_1, DEPOSIT_AMOUNT);
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
            COMMITMENT_2
        );
        vault.authorizeBet(DUMMY_PROOF, inputs);
    }

    function test_authorizeBet_storesBetRecord() public {
        bytes32 root = _depositAndGetRoot();
        vault.authorizeBet(DUMMY_PROOF, _betAuthInputs(root));
        (bytes32 mktId, bytes32 posId, uint64 shares, uint256 betAmt, Vault.BetStatus status) =
            vault.betRecords(NULLIFIER_1);
        assertEq(mktId, MARKET_ID);
        assertEq(posId, POSITION_ID);
        assertEq(shares, 200_000_000);
        assertEq(betAmt, 100 * 1e6);
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
        (,,,, Vault.BetStatus status) = vault.betRecords(null1);
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
        (,,,, Vault.BetStatus status) = vault.betRecords(null1);
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
            payout_per_share: 1_000_000, // $1 per share (6 decimals)
            total_credit: 200_000_000   // shares_held * payout_per_share
        });
    }

    function _setupFilledBet() internal {
        _authorizeBetAndGetNullifier();
        vm.prank(operator);
        vault.reportFilled(NULLIFIER_1);
    }

    function test_creditSettlement_succeeds() public {
        _setupFilledBet();
        bytes32 root = _currentRoot();
        vault.creditSettlement(DUMMY_PROOF, _settlementInputs(root));
        assertTrue(registry.isSpent(NULLIFIER_2));
        (,,,, Vault.BetStatus status) = vault.betRecords(NULLIFIER_1);
        assertEq(uint8(status), uint8(Vault.BetStatus.CREDITED));
    }

    function test_creditSettlement_revert_nullifierSpent() public {
        _setupFilledBet();
        bytes32 root = _currentRoot();
        vault.creditSettlement(DUMMY_PROOF, _settlementInputs(root));
        bytes32 root2 = _currentRoot();
        vm.expectRevert(Vault.NullifierSpent.selector);
        vault.creditSettlement(DUMMY_PROOF, _settlementInputs(root2));
    }

    function test_creditSettlement_revert_betNotFound() public {
        vm.prank(alice);
        vault.deposit(COMMITMENT_1, DEPOSIT_AMOUNT);
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
        _setupFilledBet();
        bytes32 root = _currentRoot();
        Vault.SettlementPublicInputs memory inputs = _settlementInputs(root);
        inputs.market_id = keccak256("wrong_market");
        vm.expectRevert(Vault.WrongMarket.selector);
        vault.creditSettlement(DUMMY_PROOF, inputs);
    }

    function test_creditSettlement_revert_invalidProof() public {
        _setupFilledBet();
        bytes32 root = _currentRoot();
        settlementVerifier.setShouldPass(false);
        vm.expectRevert(Vault.InvalidProof.selector);
        vault.creditSettlement(DUMMY_PROOF, _settlementInputs(root));
    }

    function test_creditSettlement_revert_doubleCreditAfterCredited() public {
        _setupFilledBet();
        bytes32 root = _currentRoot();
        vault.creditSettlement(DUMMY_PROOF, _settlementInputs(root));
        // Try to credit again with a new nullifier — bet status is CREDITED, not FILLED
        bytes32 root2 = _currentRoot();
        Vault.SettlementPublicInputs memory inputs2 = _settlementInputs(root2);
        inputs2.nullifier = keccak256("nullifier_3");
        vm.expectRevert(Vault.BetNotFilled.selector);
        vault.creditSettlement(DUMMY_PROOF, inputs2);
    }

    // =========================================================================
    // withdraw
    // =========================================================================

    function _withdrawInputs(bytes32 root, bytes32 recipientHash)
        internal
        pure
        returns (Vault.WithdrawalPublicInputs memory)
    {
        return Vault.WithdrawalPublicInputs({
            merkle_root: root,
            nullifier: NULLIFIER_2,
            withdrawal_amount: 500 * 1e6,
            recipient_hash: recipientHash
        });
    }

    function _recipientHash(address addr) internal view returns (bytes32) {
        return tree.hashTwo(bytes32(uint256(uint160(addr))), bytes32(0));
    }

    function test_withdraw_succeeds() public {
        vm.prank(alice);
        vault.deposit(COMMITMENT_1, DEPOSIT_AMOUNT);
        bytes32 root = _currentRoot();
        bytes32 rHash = _recipientHash(recipient);
        uint256 balBefore = usdc.balanceOf(recipient);
        vault.withdraw(DUMMY_PROOF, _withdrawInputs(root, rHash), recipient);
        assertEq(usdc.balanceOf(recipient) - balBefore, 500 * 1e6);
        assertTrue(registry.isSpent(NULLIFIER_2));
    }

    function test_withdraw_emitsEvent() public {
        vm.prank(alice);
        vault.deposit(COMMITMENT_1, DEPOSIT_AMOUNT);
        bytes32 root = _currentRoot();
        bytes32 rHash = _recipientHash(recipient);
        vm.expectEmit(true, false, false, true);
        emit Vault.Withdrawn(NULLIFIER_2, recipient, 500 * 1e6);
        vault.withdraw(DUMMY_PROOF, _withdrawInputs(root, rHash), recipient);
    }

    function test_withdraw_revert_nullifierSpent() public {
        vm.prank(alice);
        vault.deposit(COMMITMENT_1, DEPOSIT_AMOUNT);
        bytes32 root = _currentRoot();
        bytes32 rHash = _recipientHash(recipient);
        vault.withdraw(DUMMY_PROOF, _withdrawInputs(root, rHash), recipient);
        bytes32 root2 = _currentRoot();
        vm.expectRevert(Vault.NullifierSpent.selector);
        vault.withdraw(DUMMY_PROOF, _withdrawInputs(root2, rHash), recipient);
    }

    function test_withdraw_revert_unknownRoot() public {
        bytes32 rHash = _recipientHash(recipient);
        vm.expectRevert(Vault.UnknownRoot.selector);
        vault.withdraw(DUMMY_PROOF, _withdrawInputs(keccak256("stale"), rHash), recipient);
    }

    function test_withdraw_revert_badRecipient() public {
        vm.prank(alice);
        vault.deposit(COMMITMENT_1, DEPOSIT_AMOUNT);
        bytes32 root = _currentRoot();
        bytes32 rHash = _recipientHash(recipient);
        // Supply bob's address instead of recipient
        vm.expectRevert(Vault.BadRecipient.selector);
        vault.withdraw(DUMMY_PROOF, _withdrawInputs(root, rHash), bob);
    }

    function test_withdraw_revert_invalidProof() public {
        vm.prank(alice);
        vault.deposit(COMMITMENT_1, DEPOSIT_AMOUNT);
        bytes32 root = _currentRoot();
        bytes32 rHash = _recipientHash(recipient);
        withdrawalVerifier.setShouldPass(false);
        vm.expectRevert(Vault.InvalidProof.selector);
        vault.withdraw(DUMMY_PROOF, _withdrawInputs(root, rHash), recipient);
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
        (,,,, Vault.BetStatus status) = vault.betRecords(NULLIFIER_1);
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
        // Set all-zero numerators (N/A resolution)
        uint256[] memory numerators = new uint256[](2);
        numerators[0] = 0;
        numerators[1] = 0;
        ctf.setPayoutNumerators(MARKET_ID, numerators);
    }

    function test_naCancellationCredit_succeeds() public {
        _setupNAMarket();
        bytes32 root = _currentRoot();
        vault.naCancellationCredit(DUMMY_PROOF, _naCancelInputs(root));
        assertTrue(registry.isSpent(NULLIFIER_2));
        (,,,, Vault.BetStatus status) = vault.betRecords(NULLIFIER_1);
        assertEq(uint8(status), uint8(Vault.BetStatus.CANCELLED_CREDITED));
    }

    function test_naCancellationCredit_revert_notNA() public {
        _authorizeBetAndGetNullifier();
        // Non-zero numerators = not N/A
        uint256[] memory numerators = new uint256[](2);
        numerators[0] = 0;
        numerators[1] = 1_000_000; // YES wins
        ctf.setPayoutNumerators(MARKET_ID, numerators);
        bytes32 root = _currentRoot();
        vm.expectRevert(Vault.NotNA.selector);
        vault.naCancellationCredit(DUMMY_PROOF, _naCancelInputs(root));
    }

    function test_naCancellationCredit_revert_nullifierSpent() public {
        _setupNAMarket();
        bytes32 root = _currentRoot();
        vault.naCancellationCredit(DUMMY_PROOF, _naCancelInputs(root));
        bytes32 root2 = _currentRoot();
        Vault.NACancelPublicInputs memory inputs2 = _naCancelInputs(root2);
        inputs2.nullifier = keccak256("null_3");
        vm.expectRevert(Vault.NullifierSpent.selector);
        vault.naCancellationCredit(DUMMY_PROOF, inputs2);
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
            vault.deposit(bytes32(uint256(i + 1)), DEPOSIT_CAP / 30);
        }
        // Initial root (slot 0) is still in the window
        assertTrue(tree.isKnownRoot(initialRoot));
    }

    function test_evictedRootRejected() public {
        // Need to advance 30 leaves so the initial root gets evicted
        // but Alice cap is 50k. Use multiple addresses.
        vm.prank(alice);
        vault.deposit(COMMITMENT_1, DEPOSIT_AMOUNT);
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
            vault.deposit(bytes32(uint256(i + 100)), DEPOSIT_AMOUNT);
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
        (,,,, Vault.BetStatus status) = vault.betRecords(NULLIFIER_1);
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

    function test_setVerifier_onlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        vault.setVerifier(vault.BET_AUTH(), address(0));
    }

    function test_setSigningLayerOperator_onlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        vault.setSigningLayerOperator(attacker);
    }
}
