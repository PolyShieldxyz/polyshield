// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
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

contract Groth16AdapterTest is Test {
    uint256 internal constant BN254_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    MockBetAuthGroth16Verifier internal betAuthVerifier;
    MockSettlementCreditGroth16Verifier internal settlementVerifier;
    MockWithdrawalGroth16Verifier internal withdrawalVerifier;
    MockBetCancelGroth16Verifier internal betCancelVerifier;
    MockCancelCreditGroth16Verifier internal cancelCreditVerifier;

    BetAuthGroth16Adapter internal betAuthAdapter;
    SettlementCreditGroth16Adapter internal settlementAdapter;
    WithdrawalGroth16Adapter internal withdrawalAdapter;
    BetCancelGroth16Adapter internal betCancelAdapter;
    CancelCreditGroth16Adapter internal cancelCreditAdapter;

    function setUp() public {
        betAuthVerifier = new MockBetAuthGroth16Verifier();
        settlementVerifier = new MockSettlementCreditGroth16Verifier();
        withdrawalVerifier = new MockWithdrawalGroth16Verifier();
        betCancelVerifier = new MockBetCancelGroth16Verifier();
        cancelCreditVerifier = new MockCancelCreditGroth16Verifier();

        betAuthAdapter = new BetAuthGroth16Adapter(address(betAuthVerifier));
        settlementAdapter = new SettlementCreditGroth16Adapter(address(settlementVerifier));
        withdrawalAdapter = new WithdrawalGroth16Adapter(address(withdrawalVerifier));
        betCancelAdapter = new BetCancelGroth16Adapter(address(betCancelVerifier));
        cancelCreditAdapter = new CancelCreditGroth16Adapter(address(cancelCreditVerifier));
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

    function test_betAuthAdapter_acceptsValidProof() public {
        uint256[9] memory expected = [uint256(1), 2, 3, 4, 5, 6, 7, 8, 9];
        betAuthVerifier.setExpectedInputs(expected);

        bytes32[] memory publicInputs = new bytes32[](9);
        for (uint256 i = 0; i < expected.length; i++) {
            publicInputs[i] = bytes32(expected[i]);
        }

        assertTrue(betAuthAdapter.verify(_proof(), publicInputs));
    }

    function test_settlementAdapter_acceptsValidProof() public {
        uint256[8] memory expected = [uint256(1), 2, 3, 4, 5, 6, 7, 8];
        settlementVerifier.setExpectedInputs(expected);
        bytes32[] memory publicInputs = new bytes32[](8);
        for (uint256 i = 0; i < expected.length; i++) {
            publicInputs[i] = bytes32(expected[i]);
        }

        assertTrue(settlementAdapter.verify(_proof(), publicInputs));
    }

    function test_withdrawalAdapter_acceptsValidProof() public {
        uint256[4] memory expected = [uint256(1), 2, 3, 4];
        withdrawalVerifier.setExpectedInputs(expected);
        bytes32[] memory publicInputs = new bytes32[](4);
        for (uint256 i = 0; i < expected.length; i++) {
            publicInputs[i] = bytes32(expected[i]);
        }

        assertTrue(withdrawalAdapter.verify(_proof(), publicInputs));
    }

    function test_betCancelAdapter_acceptsValidProof() public {
        uint256[5] memory expected = [uint256(1), 2, 3, 4, 5];
        betCancelVerifier.setExpectedInputs(expected);
        bytes32[] memory publicInputs = new bytes32[](5);
        for (uint256 i = 0; i < expected.length; i++) {
            publicInputs[i] = bytes32(expected[i]);
        }

        assertTrue(betCancelAdapter.verify(_proof(), publicInputs));
    }

    function test_cancelCreditAdapter_acceptsValidProof() public {
        uint256[6] memory expected = [uint256(1), 2, 3, 4, 5, 6];
        cancelCreditVerifier.setExpectedInputs(expected);
        bytes32[] memory publicInputs = new bytes32[](6);
        for (uint256 i = 0; i < expected.length; i++) {
            publicInputs[i] = bytes32(expected[i]);
        }

        assertTrue(cancelCreditAdapter.verify(_proof(), publicInputs));
    }

    function test_betAuthAdapter_rejectsMalformedProofLength() public {
        bytes32[] memory publicInputs = new bytes32[](9);
        assertFalse(betAuthAdapter.verify(hex"deadbeef", publicInputs));
    }

    function test_betAuthAdapter_rejectsTamperedPublicInputOrdering() public {
        uint256[9] memory expected = [uint256(1), 2, 3, 4, 5, 6, 7, 8, 9];
        betAuthVerifier.setExpectedInputs(expected);

        bytes32[] memory publicInputs = new bytes32[](9);
        publicInputs[0] = bytes32(expected[1]);
        publicInputs[1] = bytes32(expected[0]);
        for (uint256 i = 2; i < expected.length; i++) {
            publicInputs[i] = bytes32(expected[i]);
        }

        assertFalse(betAuthAdapter.verify(_proof(), publicInputs));
    }

    function test_betAuthAdapter_rejectsOutOfFieldPublicInput() public {
        uint256[9] memory expected = [uint256(1), 2, 3, 4, 5, 6, 7, 8, 9];
        betAuthVerifier.setExpectedInputs(expected);

        bytes32[] memory publicInputs = new bytes32[](9);
        for (uint256 i = 0; i < expected.length; i++) {
            publicInputs[i] = bytes32(expected[i]);
        }
        publicInputs[0] = bytes32(BN254_SCALAR_FIELD);

        assertFalse(betAuthAdapter.verify(_proof(), publicInputs));
    }
}
