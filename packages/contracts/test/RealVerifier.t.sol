// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DepositVerifier} from "../src/verifiers/DepositVerifier.sol";
import {PositionCloseVerifier} from "../src/verifiers/PositionCloseVerifier.sol";
import {PartialCreditVerifier} from "../src/verifiers/PartialCreditVerifier.sol";

/// @notice End-to-end on-chain verification of the two FC-1/FC-2 Groth16 verifiers
/// against REAL proofs (not MockVerifier). Confirms the snarkjs-generated pairing,
/// the IC public-input count, and the frontend's ABI/G2-swap proof encoding all
/// agree with the Solidity adapter. Fixtures are produced by the snarkjs pipeline
/// in Benchmarking/groth16 and committed under test/fixtures/.
contract RealVerifierTest is Test {
    DepositVerifier deposit;
    PositionCloseVerifier positionClose;
    PartialCreditVerifier partialCredit;

    function setUp() public {
        deposit = new DepositVerifier();
        positionClose = new PositionCloseVerifier();
        partialCredit = new PartialCreditVerifier();
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
}
