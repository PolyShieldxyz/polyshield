// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../../src/Vault.sol";
import {CommitmentMerkleTree} from "../../src/CommitmentMerkleTree.sol";
import {NullifierRegistry} from "../../src/NullifierRegistry.sol";
import {MockPoseidonField} from "../../src/mocks/MockPoseidonField.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {MockCTF} from "../../src/mocks/MockCTF.sol";
import {BetAuthGroth16Adapter} from "@groth16/adapters/BetAuthGroth16Adapter.sol";
import {SettlementCreditGroth16Adapter} from "@groth16/adapters/SettlementCreditGroth16Adapter.sol";
import {WithdrawalGroth16Adapter} from "@groth16/adapters/WithdrawalGroth16Adapter.sol";
import {BetCancelGroth16Adapter} from "@groth16/adapters/BetCancelGroth16Adapter.sol";
import {CancelCreditGroth16Adapter} from "@groth16/adapters/CancelCreditGroth16Adapter.sol";
import {MockBetAuthGroth16Verifier} from "@groth16/mocks/MockBetAuthGroth16Verifier.sol";
import {MockSettlementCreditGroth16Verifier} from "@groth16/mocks/MockSettlementCreditGroth16Verifier.sol";
import {MockWithdrawalGroth16Verifier} from "@groth16/mocks/MockWithdrawalGroth16Verifier.sol";
import {MockBetCancelGroth16Verifier} from "@groth16/mocks/MockBetCancelGroth16Verifier.sol";
import {MockCancelCreditGroth16Verifier} from "@groth16/mocks/MockCancelCreditGroth16Verifier.sol";

contract VaultGroth16Test is Test {
    Vault internal vault;
    CommitmentMerkleTree internal tree;
    NullifierRegistry internal registry;
    MockPoseidonField internal poseidon;
    MockUSDC internal usdc;
    MockCTF internal ctf;

    MockBetAuthGroth16Verifier internal betAuthVerifier;
    MockSettlementCreditGroth16Verifier internal settlementVerifier;
    MockWithdrawalGroth16Verifier internal withdrawalVerifier;
    MockBetCancelGroth16Verifier internal betCancelVerifier;
    MockCancelCreditGroth16Verifier internal cancelCreditVerifier;

    address internal owner = address(0x1111);
    address internal operator = address(0x2222);
    address internal depositWallet = address(0x3333);
    address internal alice = address(0xA1CE);
    address internal recipient = address(0xBEEF);

    bytes32 internal constant COMMITMENT_1 = bytes32(uint256(101));
    bytes32 internal constant COMMITMENT_2 = bytes32(uint256(102));
    bytes32 internal constant COMMITMENT_3 = bytes32(uint256(103));
    bytes32 internal constant NULLIFIER_1 = bytes32(uint256(201));
    bytes32 internal constant NULLIFIER_2 = bytes32(uint256(202));
    bytes32 internal constant BET_NOTE_NULLIFIER = bytes32(uint256(203));
    bytes32 internal constant MARKET_ID = bytes32(uint256(301));
    bytes32 internal constant POSITION_ID = bytes32(uint256(302));
    uint256 internal constant DEPOSIT_AMOUNT = 1_000 * 1e6;

    function setUp() public {
        poseidon = new MockPoseidonField();
        usdc = new MockUSDC();
        ctf = new MockCTF();

        address predictedVault = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);

        registry = new NullifierRegistry(predictedVault);
        tree = new CommitmentMerkleTree(predictedVault, address(poseidon));
        vault = new Vault(
            address(usdc),
            address(tree),
            address(registry),
            address(0),
            address(0),
            address(ctf),
            operator,
            depositWallet,
            owner
        );

        betAuthVerifier = new MockBetAuthGroth16Verifier();
        settlementVerifier = new MockSettlementCreditGroth16Verifier();
        withdrawalVerifier = new MockWithdrawalGroth16Verifier();
        betCancelVerifier = new MockBetCancelGroth16Verifier();
        cancelCreditVerifier = new MockCancelCreditGroth16Verifier();

        vm.startPrank(owner);
        vault.setVerifier(vault.BET_AUTH(), address(new BetAuthGroth16Adapter(address(betAuthVerifier))));
        vault.setVerifier(vault.SETTLEMENT_CREDIT(), address(new SettlementCreditGroth16Adapter(address(settlementVerifier))));
        vault.setVerifier(vault.WITHDRAWAL(), address(new WithdrawalGroth16Adapter(address(withdrawalVerifier))));
        vault.setVerifier(vault.BET_CANCEL(), address(new BetCancelGroth16Adapter(address(betCancelVerifier))));
        vault.setVerifier(vault.CANCEL_CREDIT(), address(new CancelCreditGroth16Adapter(address(cancelCreditVerifier))));
        vm.stopPrank();

        usdc.mint(alice, DEPOSIT_AMOUNT * 10);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);

        uint256[] memory naNumerators = new uint256[](2);
        ctf.setPayoutNumerators(MARKET_ID, naNumerators);
        ctf.setPayoutDenominator(MARKET_ID, 1_000_000);
    }

    function _proof() internal pure returns (bytes memory) {
        uint256[2] memory a;
        uint256[2][2] memory b;
        uint256[2] memory c;
        a[0] = 1;
        a[1] = 2;
        b[0][0] = 3;
        b[0][1] = 4;
        b[1][0] = 5;
        b[1][1] = 6;
        c[0] = 7;
        c[1] = 8;
        return abi.encode(a, b, c);
    }

    function _currentRoot() internal view returns (bytes32) {
        return tree.recentRoots(tree.currentRootIndex());
    }

    function _depositAndRoot() internal returns (bytes32) {
        vm.prank(alice);
        vault.deposit(COMMITMENT_1, DEPOSIT_AMOUNT);
        return _currentRoot();
    }

    function _betInputs(bytes32 root) internal pure returns (Vault.BetAuthPublicInputs memory) {
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

    function test_authorizeBet_withGroth16Adapter_succeeds() public {
        bytes32 root = _depositAndRoot();
        Vault.BetAuthPublicInputs memory inputs = _betInputs(root);

        uint256[9] memory expected = [
            uint256(root),
            uint256(NULLIFIER_1),
            uint256(COMMITMENT_2),
            uint256(inputs.bet_amount),
            uint256(inputs.price),
            uint256(inputs.expected_shares),
            uint256(MARKET_ID),
            uint256(inputs.outcome_side),
            uint256(POSITION_ID)
        ];
        betAuthVerifier.setExpectedInputs(expected);

        vault.authorizeBet(_proof(), inputs);
        assertTrue(registry.isSpent(NULLIFIER_1));
    }

    function test_creditSettlement_withGroth16Adapter_succeeds() public {
        bytes32 root = _depositAndRoot();
        Vault.BetAuthPublicInputs memory betInputs = _betInputs(root);
        uint256[9] memory betExpected = [
            uint256(root),
            uint256(NULLIFIER_1),
            uint256(COMMITMENT_2),
            uint256(betInputs.bet_amount),
            uint256(betInputs.price),
            uint256(betInputs.expected_shares),
            uint256(MARKET_ID),
            uint256(betInputs.outcome_side),
            uint256(POSITION_ID)
        ];
        betAuthVerifier.setExpectedInputs(betExpected);
        vault.authorizeBet(_proof(), betInputs);

        vm.prank(operator);
        vault.reportFilled(NULLIFIER_1);

        bytes32 root2 = _currentRoot();
        Vault.SettlementPublicInputs memory settlementInputs = Vault.SettlementPublicInputs({
            merkle_root: root2,
            nullifier: BET_NOTE_NULLIFIER,
            new_commitment: COMMITMENT_3,
            nullifier_of_bet: NULLIFIER_1,
            market_id: MARKET_ID,
            payout_per_share: 1_000_000,
            total_credit: 200_000_000_000_000
        });

        uint256[8] memory settlementExpected = [
            uint256(root2),
            uint256(BET_NOTE_NULLIFIER),
            uint256(COMMITMENT_3),
            uint256(NULLIFIER_1),
            uint256(MARKET_ID),
            uint256(settlementInputs.payout_per_share),
            uint256(betInputs.expected_shares),
            uint256(settlementInputs.total_credit)
        ];
        settlementVerifier.setExpectedInputs(settlementExpected);

        vault.creditSettlement(_proof(), settlementInputs);
        assertTrue(registry.isSpent(BET_NOTE_NULLIFIER));
    }

    function test_withdraw_withGroth16Adapter_succeeds() public {
        bytes32 root = _depositAndRoot();
        bytes32 recipientHash = tree.hashTwo(bytes32(uint256(uint160(recipient))), bytes32(0));
        Vault.WithdrawalPublicInputs memory inputs = Vault.WithdrawalPublicInputs({
            merkle_root: root,
            nullifier: NULLIFIER_2,
            withdrawal_amount: 250 * 1e6,
            recipient_hash: recipientHash
        });

        uint256[4] memory expected = [
            uint256(root),
            uint256(NULLIFIER_2),
            uint256(inputs.withdrawal_amount),
            uint256(recipientHash)
        ];
        withdrawalVerifier.setExpectedInputs(expected);

        uint256 beforeBalance = usdc.balanceOf(recipient);
        vault.withdraw(_proof(), inputs, recipient);
        assertEq(usdc.balanceOf(recipient), beforeBalance + inputs.withdrawal_amount);
    }

    function test_betCancellationCredit_withGroth16Adapter_succeeds() public {
        bytes32 root = _depositAndRoot();
        Vault.BetAuthPublicInputs memory betInputs = _betInputs(root);
        uint256[9] memory betExpected = [
            uint256(root),
            uint256(NULLIFIER_1),
            uint256(COMMITMENT_2),
            uint256(betInputs.bet_amount),
            uint256(betInputs.price),
            uint256(betInputs.expected_shares),
            uint256(MARKET_ID),
            uint256(betInputs.outcome_side),
            uint256(POSITION_ID)
        ];
        betAuthVerifier.setExpectedInputs(betExpected);
        vault.authorizeBet(_proof(), betInputs);

        vm.prank(operator);
        vault.reportFOKFailure(NULLIFIER_1);

        bytes32 root2 = _currentRoot();
        Vault.BetCancelPublicInputs memory cancelInputs = Vault.BetCancelPublicInputs({
            merkle_root: root2,
            nullifier: BET_NOTE_NULLIFIER,
            new_commitment: COMMITMENT_3,
            nullifier_of_bet: NULLIFIER_1
        });

        uint256[5] memory expected = [
            uint256(root2),
            uint256(BET_NOTE_NULLIFIER),
            uint256(COMMITMENT_3),
            uint256(NULLIFIER_1),
            uint256(betInputs.bet_amount)
        ];
        betCancelVerifier.setExpectedInputs(expected);

        vault.betCancellationCredit(_proof(), cancelInputs);
        assertTrue(registry.isSpent(BET_NOTE_NULLIFIER));
    }

    function test_naCancellationCredit_withGroth16Adapter_succeeds() public {
        bytes32 root = _depositAndRoot();
        Vault.BetAuthPublicInputs memory betInputs = _betInputs(root);
        uint256[9] memory betExpected = [
            uint256(root),
            uint256(NULLIFIER_1),
            uint256(COMMITMENT_2),
            uint256(betInputs.bet_amount),
            uint256(betInputs.price),
            uint256(betInputs.expected_shares),
            uint256(MARKET_ID),
            uint256(betInputs.outcome_side),
            uint256(POSITION_ID)
        ];
        betAuthVerifier.setExpectedInputs(betExpected);
        vault.authorizeBet(_proof(), betInputs);

        bytes32 root2 = _currentRoot();
        Vault.NACancelPublicInputs memory cancelInputs = Vault.NACancelPublicInputs({
            merkle_root: root2,
            nullifier: BET_NOTE_NULLIFIER,
            new_commitment: COMMITMENT_3,
            nullifier_of_bet: NULLIFIER_1,
            market_id: MARKET_ID
        });

        uint256[6] memory expected = [
            uint256(root2),
            uint256(BET_NOTE_NULLIFIER),
            uint256(COMMITMENT_3),
            uint256(NULLIFIER_1),
            uint256(MARKET_ID),
            uint256(betInputs.bet_amount)
        ];
        cancelCreditVerifier.setExpectedInputs(expected);

        vault.naCancellationCredit(_proof(), cancelInputs);
        assertTrue(registry.isSpent(BET_NOTE_NULLIFIER));
    }
}
