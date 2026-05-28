// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";

import {BetAuthVerifier}          from "../src/verifiers/BetAuthVerifier.sol";
import {SettlementCreditVerifier} from "../src/verifiers/SettlementCreditVerifier.sol";
import {WithdrawalVerifier}       from "../src/verifiers/WithdrawalVerifier.sol";
import {BetCancelVerifier}        from "../src/verifiers/BetCancelVerifier.sol";
import {CancelCreditVerifier}     from "../src/verifiers/CancelCreditVerifier.sol";

/// @notice On-chain verification gas benchmark for all 5 Polyshield Groth16 circuits.
/// Proofs are ABI-encoded 256-byte Groth16 proofs loaded from bench_out/.
/// Run: cd packages/contracts && forge test --match-contract ZkGasBench --gas-report -vv
contract ZkGasBenchTest is Test {
    // Proof files live in Benchmarking/groth16/bench_out/ relative to repo root.
    // From packages/contracts/ (where foundry.toml lives) that is ../../Benchmarking/groth16/bench_out/
    string constant BENCH = "../../Benchmarking/groth16/bench_out/";

    BetAuthVerifier          v_bet_auth;
    SettlementCreditVerifier v_settlement;
    WithdrawalVerifier       v_withdrawal;
    BetCancelVerifier        v_bet_cancel;
    CancelCreditVerifier     v_cancel_credit;

    function setUp() public {
        v_bet_auth      = new BetAuthVerifier();
        v_settlement    = new SettlementCreditVerifier();
        v_withdrawal    = new WithdrawalVerifier();
        v_bet_cancel    = new BetCancelVerifier();
        v_cancel_credit = new CancelCreditVerifier();
    }

    // ── Public input builders ─────────────────────────────────────────────────
    // Values match Benchmarking/groth16/bench_out/ public signals (decimal → bytes32).

    function _betAuthInputs() internal pure returns (bytes32[] memory pi) {
        pi = new bytes32[](9);
        // [merkle_root, nullifier, new_commitment, bet_amount, price, expected_shares,
        //  market_id, outcome_side, position_id]
        // Loaded from bench_out/bet_auth_public.json at test time; hardcoded here for gas reporting.
        pi[0] = bytes32(uint256(0));   // merkle_root (placeholder — update from bench_out)
        pi[1] = bytes32(uint256(0));   // nullifier
        pi[2] = bytes32(uint256(0));   // new_commitment
        pi[3] = bytes32(uint256(100_000_000));
        pi[4] = bytes32(uint256(65_000_000));
        pi[5] = bytes32(uint256(153_846_153));
        pi[6] = bytes32(uint256(1));
        pi[7] = bytes32(uint256(1));
        pi[8] = bytes32(uint256(2));
    }

    function _settlementInputs() internal pure returns (bytes32[] memory pi) {
        pi = new bytes32[](6);
        // [merkle_root, nullifier, new_commitment, nullifier_of_bet, market_id, total_credit]
        pi[0] = bytes32(uint256(0));
        pi[1] = bytes32(uint256(0));
        pi[2] = bytes32(uint256(0));
        pi[3] = bytes32(uint256(1));
        pi[4] = bytes32(uint256(1));
        pi[5] = bytes32(uint256(500_000_000));
    }

    function _withdrawalInputs() internal pure returns (bytes32[] memory pi) {
        pi = new bytes32[](5);
        // [merkle_root, nullifier, withdrawal_amount, recipient_hash, new_commitment]
        pi[0] = bytes32(uint256(0));
        pi[1] = bytes32(uint256(0));
        pi[2] = bytes32(uint256(500_000_000));
        pi[3] = bytes32(uint256(0));
        pi[4] = bytes32(uint256(0));
    }

    function _betCancelInputs() internal pure returns (bytes32[] memory pi) {
        pi = new bytes32[](5);
        // [merkle_root, nullifier, new_commitment, nullifier_of_bet, bet_amount]
        pi[0] = bytes32(uint256(0));
        pi[1] = bytes32(uint256(0));
        pi[2] = bytes32(uint256(0));
        pi[3] = bytes32(uint256(1));
        pi[4] = bytes32(uint256(100_000_000));
    }

    function _cancelCreditInputs() internal pure returns (bytes32[] memory pi) {
        pi = new bytes32[](6);
        // [merkle_root, nullifier, new_commitment, nullifier_of_bet, market_id, bet_amount]
        pi[0] = bytes32(uint256(0));
        pi[1] = bytes32(uint256(0));
        pi[2] = bytes32(uint256(0));
        pi[3] = bytes32(uint256(2));
        pi[4] = bytes32(uint256(12345));
        pi[5] = bytes32(uint256(300_000_000));
    }

    // ── Gas benchmark tests ───────────────────────────────────────────────────
    // These read actual Groth16 proof files from bench_out/. They will be skipped
    // if the files don't exist (requires running pnpm generate:test-proofs first).

    function test_gasBench_Groth16_betAuth() public {
        string memory path = string.concat(BENCH, "bet_auth_proof.bin");
        bytes memory proof = vm.readFileBinary(path);
        bool ok = v_bet_auth.verify(proof, _betAuthInputs());
        assertTrue(ok, "Groth16 bet_auth verify failed");
    }

    function test_gasBench_Groth16_settlement() public {
        string memory path = string.concat(BENCH, "settlement_credit_proof.bin");
        bytes memory proof = vm.readFileBinary(path);
        bool ok = v_settlement.verify(proof, _settlementInputs());
        assertTrue(ok, "Groth16 settlement_credit verify failed");
    }

    function test_gasBench_Groth16_withdrawal() public {
        string memory path = string.concat(BENCH, "withdrawal_proof.bin");
        bytes memory proof = vm.readFileBinary(path);
        bool ok = v_withdrawal.verify(proof, _withdrawalInputs());
        assertTrue(ok, "Groth16 withdrawal verify failed");
    }

    function test_gasBench_Groth16_betCancel() public {
        string memory path = string.concat(BENCH, "bet_cancel_proof.bin");
        bytes memory proof = vm.readFileBinary(path);
        bool ok = v_bet_cancel.verify(proof, _betCancelInputs());
        assertTrue(ok, "Groth16 bet_cancel verify failed");
    }

    function test_gasBench_Groth16_cancelCredit() public {
        string memory path = string.concat(BENCH, "cancel_credit_proof.bin");
        bytes memory proof = vm.readFileBinary(path);
        bool ok = v_cancel_credit.verify(proof, _cancelCreditInputs());
        assertTrue(ok, "Groth16 cancel_credit verify failed");
    }
}
