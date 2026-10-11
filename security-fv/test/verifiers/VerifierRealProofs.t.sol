// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IVerifier} from "polyshield/interfaces/IVerifier.sol";
import {BetAuthVerifier} from "polyshield/verifiers/BetAuthVerifier.sol";
import {SettlementCreditVerifier} from "polyshield/verifiers/SettlementCreditVerifier.sol";
import {WithdrawalVerifier} from "polyshield/verifiers/WithdrawalVerifier.sol";
import {BetCancelVerifier} from "polyshield/verifiers/BetCancelVerifier.sol";
import {CancelCreditVerifier} from "polyshield/verifiers/CancelCreditVerifier.sol";
import {DepositVerifier} from "polyshield/verifiers/DepositVerifier.sol";
import {PositionCloseVerifier} from "polyshield/verifiers/PositionCloseVerifier.sol";
import {PartialCreditVerifier} from "polyshield/verifiers/PartialCreditVerifier.sol";
import {ConsolidateVerifier} from "polyshield/verifiers/ConsolidateVerifier.sol";

/// @notice Concrete, real-proof adversarial tests of every deployed-form verifier (adapter behind ERC1967 proxy).
/// For each of the nine committed Groth16 proof fixtures:
///   * the genuine proof verifies;
///   * every public signal s_i, replaced by s_i+1, by s_i+r (the F_r alias), by r, and by 2^256-1, is rejected;
///   * every one of the 8 proof words, perturbed, is rejected (or reverts) -- never accepted;
///   * the all-zero proof is rejected; a proof under the WRONG verifier slot is rejected;
///   * too-few public signals revert (cannot be accepted), extra trailing signals are ignored by design.
contract VerifierRealProofs is Test {
    uint256 internal constant R = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    string[9] internal files = ["bet_auth", "settlement_credit", "withdrawal", "bet_cancel", "cancel_credit", "deposit",
        "position_close", "partial_credit", "consolidate"];
    IVerifier[9] internal v;

    function _p(address impl, bytes memory init) internal returns (IVerifier) {
        return IVerifier(address(new ERC1967Proxy(impl, init)));
    }

    function setUp() public {
        bytes memory init = abi.encodeWithSignature("initialize(address)", address(this));
        v[0] = _p(address(new BetAuthVerifier()), init);
        v[1] = _p(address(new SettlementCreditVerifier()), init);
        v[2] = _p(address(new WithdrawalVerifier()), init);
        v[3] = _p(address(new BetCancelVerifier()), init);
        v[4] = _p(address(new CancelCreditVerifier()), init);
        v[5] = _p(address(new DepositVerifier()), init);
        v[6] = _p(address(new PositionCloseVerifier()), init);
        v[7] = _p(address(new PartialCreditVerifier()), init);
        v[8] = _p(address(new ConsolidateVerifier()), init);
    }

    function _load(uint256 k) internal view returns (bytes memory proof, bytes32[] memory sig) {
        string memory json = vm.readFile(string.concat("../packages/contracts/test/fixtures/", files[k], "_proof.json"));
        proof = vm.parseJsonBytes(json, ".proof");
        string[] memory ss = vm.parseJsonStringArray(json, ".signals");
        sig = new bytes32[](ss.length);
        for (uint256 i = 0; i < ss.length; i++) sig[i] = bytes32(vm.parseUint(ss[i]));
    }

    function _accepts(IVerifier ver, bytes memory proof, bytes32[] memory sig) internal view returns (bool ok) {
        // an invalid curve point makes the bn256 precompile burn all forwarded gas, so cap it per call
        try ver.verify{gas: 2_000_000}(proof, sig) returns (bool r) { ok = r; } catch { ok = false; }
    }

    function _copy(bytes32[] memory a) internal pure returns (bytes32[] memory b) {
        b = new bytes32[](a.length);
        for (uint256 i = 0; i < a.length; i++) b[i] = a[i];
    }

    function test_genuineProofsVerify() public view {
        for (uint256 k = 0; k < 9; k++) {
            (bytes memory proof, bytes32[] memory sig) = _load(k);
            assertTrue(v[k].verify(proof, sig), files[k]);
        }
    }

    function test_everyPublicSignal_rejectsTamperAndAlias() public view {
        uint256 checks;
        for (uint256 k = 0; k < 9; k++) {
            (bytes memory proof, bytes32[] memory sig) = _load(k);
            for (uint256 i = 0; i < sig.length; i++) {
                uint256 s = uint256(sig[i]);
                uint256[4] memory bad = [s + 1, s + R, R, type(uint256).max];
                for (uint256 j = 0; j < 4; j++) {
                    bytes32[] memory t = _copy(sig);
                    t[i] = bytes32(bad[j]);
                    assertFalse(_accepts(v[k], proof, t), string.concat(files[k], ": tampered/aliased signal accepted"));
                    checks++;
                }
            }
        }
        assertGt(checks, 150);
    }

    function test_everyProofWord_rejectsTamper() public view {
        for (uint256 k = 0; k < 9; k++) {
            (bytes memory proof, bytes32[] memory sig) = _load(k);
            for (uint256 w = 0; w < 8; w++) {
                bytes memory p = proof;
                bytes memory t = new bytes(p.length);
                for (uint256 b = 0; b < p.length; b++) t[b] = p[b];
                uint256 word;
                assembly { word := mload(add(add(t, 32), mul(w, 32))) }
                word += 1;
                assembly { mstore(add(add(t, 32), mul(w, 32)), word) }
                assertFalse(_accepts(v[k], t, sig), string.concat(files[k], ": tampered proof word accepted"));
            }
        }
    }

    function test_zeroProofAndCrossSlotRejected() public view {
        for (uint256 k = 0; k < 9; k++) {
            (bytes memory proof, bytes32[] memory sig) = _load(k);
            assertFalse(_accepts(v[k], new bytes(256), sig), "all-zero proof");
            // the proof of circuit k under any other circuit's verifier must fail (when arities allow the call)
            for (uint256 m = 0; m < 9; m++) {
                if (m == k) continue;
                assertFalse(_accepts(v[m], proof, sig), string.concat(files[k], " proof accepted by ", files[m], " verifier"));
            }
        }
    }

    function test_publicInputLengthBehaviour() public {
        for (uint256 k = 0; k < 9; k++) {
            (bytes memory proof, bytes32[] memory sig) = _load(k);
            // too few -> out-of-bounds revert (can never be accepted)
            bytes32[] memory few = new bytes32[](sig.length - 1);
            for (uint256 i = 0; i < few.length; i++) few[i] = sig[i];
            vm.expectRevert();
            v[k].verify(proof, few);
            // extra trailing entries are ignored by the adapter (documented behaviour; Vault always passes the exact length)
            bytes32[] memory extra = new bytes32[](sig.length + 1);
            for (uint256 i = 0; i < sig.length; i++) extra[i] = sig[i];
            extra[sig.length] = bytes32(uint256(12345));
            assertTrue(v[k].verify(proof, extra), "extra trailing public input ignored");
        }
    }
}
