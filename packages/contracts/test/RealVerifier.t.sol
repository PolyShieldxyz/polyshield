// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BetAuthVerifier} from "../src/verifiers/BetAuthVerifier.sol";
import {SettlementCreditVerifier} from "../src/verifiers/SettlementCreditVerifier.sol";
import {WithdrawalVerifier} from "../src/verifiers/WithdrawalVerifier.sol";
import {BetCancelVerifier} from "../src/verifiers/BetCancelVerifier.sol";
import {CancelCreditVerifier} from "../src/verifiers/CancelCreditVerifier.sol";
import {DepositVerifier} from "../src/verifiers/DepositVerifier.sol";
import {PositionCloseVerifier} from "../src/verifiers/PositionCloseVerifier.sol";
import {PartialCreditVerifier} from "../src/verifiers/PartialCreditVerifier.sol";
import {ConsolidateVerifier} from "../src/verifiers/ConsolidateVerifier.sol";
import {DeployLib} from "../script/DeployLib.sol";

/// @notice End-to-end on-chain verification of ALL EIGHT Groth16 verifiers against
/// REAL proofs (not MockVerifier). Confirms the snarkjs-generated pairing, the IC
/// public-input count, and the frontend's ABI/G2-swap proof encoding all agree with
/// the Solidity adapter. Fixtures are produced by the snarkjs pipeline in
/// Benchmarking/groth16 (pnpm generate:test-proofs) and committed under test/fixtures/.
contract RealVerifierTest is Test {
    BetAuthVerifier betAuth;
    SettlementCreditVerifier settlementCredit;
    WithdrawalVerifier withdrawal;
    BetCancelVerifier betCancel;
    CancelCreditVerifier cancelCredit;
    DepositVerifier deposit;
    PositionCloseVerifier positionClose;
    PartialCreditVerifier partialCredit;
    ConsolidateVerifier consolidate;

    function setUp() public {
        // Each verifier adapter is UUPS-upgradeable: deploy impl + ERC1967 proxy.
        // initialize() deploys the G16Base; verify() routes proxy → base.verifyProof().
        betAuth = BetAuthVerifier(DeployLib.deployOwnedProxy(address(new BetAuthVerifier()), address(this)));
        settlementCredit =
            SettlementCreditVerifier(DeployLib.deployOwnedProxy(address(new SettlementCreditVerifier()), address(this)));
        withdrawal = WithdrawalVerifier(DeployLib.deployOwnedProxy(address(new WithdrawalVerifier()), address(this)));
        betCancel = BetCancelVerifier(DeployLib.deployOwnedProxy(address(new BetCancelVerifier()), address(this)));
        cancelCredit =
            CancelCreditVerifier(DeployLib.deployOwnedProxy(address(new CancelCreditVerifier()), address(this)));
        deposit = DepositVerifier(DeployLib.deployOwnedProxy(address(new DepositVerifier()), address(this)));
        positionClose =
            PositionCloseVerifier(DeployLib.deployOwnedProxy(address(new PositionCloseVerifier()), address(this)));
        partialCredit =
            PartialCreditVerifier(DeployLib.deployOwnedProxy(address(new PartialCreditVerifier()), address(this)));
        consolidate =
            ConsolidateVerifier(DeployLib.deployOwnedProxy(address(new ConsolidateVerifier()), address(this)));
    }

    function _load(string memory file)
        internal
        view
        returns (bytes memory proof, bytes32[] memory signals)
    {
        string memory json = vm.readFile(string.concat("test/fixtures/", file));
        proof = vm.parseJsonBytes(json, ".proof");
        string[] memory sigs = vm.parseJsonStringArray(json, ".signals");
        signals = new bytes32[](sigs.length);
        for (uint256 i = 0; i < sigs.length; i++) {
            signals[i] = bytes32(vm.parseUint(sigs[i]));
        }
    }

    // ── deposit (FC-2) ─────────────────────────────────────────────────────────

    function test_realDepositProof_verifies() public view {
        (bytes memory proof, bytes32[] memory signals) = _load("deposit_proof.json");
        assertEq(signals.length, 3, "deposit must expose 3 public inputs");
        assertTrue(deposit.verify(proof, signals), "real deposit proof must verify");
    }

    function test_realDepositProof_rejectsTamperedInput() public view {
        (bytes memory proof, bytes32[] memory signals) = _load("deposit_proof.json");
        signals[1] = bytes32(uint256(signals[1]) + 1); // tamper amount
        assertFalse(deposit.verify(proof, signals), "tampered public input must not verify");
    }

    // ── bet_auth ─────────────────────────────────────────────────────────────────

    function test_realBetAuthProof_verifies() public view {
        (bytes memory proof, bytes32[] memory signals) = _load("bet_auth_proof.json");
        assertEq(signals.length, 9, "bet_auth must expose 9 public inputs");
        assertTrue(betAuth.verify(proof, signals), "real bet_auth proof must verify");
    }

    function test_realBetAuthProof_rejectsTamperedInput() public view {
        (bytes memory proof, bytes32[] memory signals) = _load("bet_auth_proof.json");
        signals[3] = bytes32(uint256(signals[3]) + 1); // tamper bet_amount
        assertFalse(betAuth.verify(proof, signals), "tampered public input must not verify");
    }

    // ── settlement_credit ──────────────────────────────────────────────────────

    function test_realSettlementCreditProof_verifies() public view {
        (bytes memory proof, bytes32[] memory signals) = _load("settlement_credit_proof.json");
        assertEq(signals.length, 6, "settlement_credit must expose 6 public inputs");
        assertTrue(settlementCredit.verify(proof, signals), "real settlement_credit proof must verify");
    }

    function test_realSettlementCreditProof_rejectsTamperedInput() public view {
        (bytes memory proof, bytes32[] memory signals) = _load("settlement_credit_proof.json");
        signals[5] = bytes32(uint256(signals[5]) + 1); // tamper total_credit
        assertFalse(settlementCredit.verify(proof, signals), "tampered public input must not verify");
    }

    // ── withdrawal ───────────────────────────────────────────────────────────────

    function test_realWithdrawalProof_verifies() public view {
        (bytes memory proof, bytes32[] memory signals) = _load("withdrawal_proof.json");
        assertEq(signals.length, 5, "withdrawal must expose 5 public inputs");
        assertTrue(withdrawal.verify(proof, signals), "real withdrawal proof must verify");
    }

    function test_realWithdrawalProof_rejectsTamperedInput() public view {
        (bytes memory proof, bytes32[] memory signals) = _load("withdrawal_proof.json");
        signals[2] = bytes32(uint256(signals[2]) + 1); // tamper withdrawal_amount
        assertFalse(withdrawal.verify(proof, signals), "tampered public input must not verify");
    }

    // ── bet_cancel ───────────────────────────────────────────────────────────────

    function test_realBetCancelProof_verifies() public view {
        (bytes memory proof, bytes32[] memory signals) = _load("bet_cancel_proof.json");
        assertEq(signals.length, 5, "bet_cancel must expose 5 public inputs");
        assertTrue(betCancel.verify(proof, signals), "real bet_cancel proof must verify");
    }

    function test_realBetCancelProof_rejectsTamperedInput() public view {
        (bytes memory proof, bytes32[] memory signals) = _load("bet_cancel_proof.json");
        signals[4] = bytes32(uint256(signals[4]) + 1); // tamper bet_amount
        assertFalse(betCancel.verify(proof, signals), "tampered public input must not verify");
    }

    // ── cancel_credit ────────────────────────────────────────────────────────────

    function test_realCancelCreditProof_verifies() public view {
        (bytes memory proof, bytes32[] memory signals) = _load("cancel_credit_proof.json");
        assertEq(signals.length, 6, "cancel_credit must expose 6 public inputs");
        assertTrue(cancelCredit.verify(proof, signals), "real cancel_credit proof must verify");
    }

    function test_realCancelCreditProof_rejectsTamperedInput() public view {
        (bytes memory proof, bytes32[] memory signals) = _load("cancel_credit_proof.json");
        signals[5] = bytes32(uint256(signals[5]) + 1); // tamper bet_amount
        assertFalse(cancelCredit.verify(proof, signals), "tampered public input must not verify");
    }

    // ── position_close (FC-1) ─────────────────────────────────────────────────────

    function test_realPositionCloseProof_verifies() public view {
        (bytes memory proof, bytes32[] memory signals) = _load("position_close_proof.json");
        assertEq(signals.length, 5, "position_close must expose 5 public inputs");
        assertTrue(positionClose.verify(proof, signals), "real position_close proof must verify");
    }

    function test_realPositionCloseProof_rejectsTamperedInput() public view {
        (bytes memory proof, bytes32[] memory signals) = _load("position_close_proof.json");
        signals[4] = bytes32(uint256(signals[4]) + 1); // tamper sell_proceeds
        assertFalse(positionClose.verify(proof, signals), "tampered public input must not verify");
    }

    // ── partial_credit (FC-4) ─────────────────────────────────────────────────────

    function test_realPartialCreditProof_verifies() public view {
        (bytes memory proof, bytes32[] memory signals) = _load("partial_credit_proof.json");
        assertEq(signals.length, 5, "partial_credit must expose 5 public inputs");
        assertTrue(partialCredit.verify(proof, signals), "real partial_credit proof must verify");
    }

    function test_realPartialCreditProof_rejectsTamperedInput() public view {
        (bytes memory proof, bytes32[] memory signals) = _load("partial_credit_proof.json");
        signals[4] = bytes32(uint256(signals[4]) + 1); // tamper refund_amount
        assertFalse(partialCredit.verify(proof, signals), "tampered public input must not verify");
    }

    // ── consolidate (FC-8) ────────────────────────────────────────────────────────

    function test_realConsolidateProof_verifies() public view {
        (bytes memory proof, bytes32[] memory signals) = _load("consolidate_proof.json");
        assertEq(signals.length, 6, "consolidate must expose 6 public inputs");
        assertTrue(consolidate.verify(proof, signals), "real consolidate proof must verify");
    }

    function test_realConsolidateProof_rejectsTamperedInput() public view {
        (bytes memory proof, bytes32[] memory signals) = _load("consolidate_proof.json");
        signals[5] = bytes32(uint256(signals[5]) + 1); // tamper new_commitment
        assertFalse(consolidate.verify(proof, signals), "tampered public input must not verify");
    }
}
