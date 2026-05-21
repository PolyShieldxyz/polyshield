// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockSettlementCreditGroth16Verifier {
    bool public shouldPass = true;
    bytes32 public expectedInputsHash;

    function setShouldPass(bool shouldPass_) external {
        shouldPass = shouldPass_;
    }

    function setExpectedInputs(uint256[8] memory input) external {
        expectedInputsHash = keccak256(abi.encode(input));
    }

    function verifyProof(
        uint256[2] memory,
        uint256[2][2] memory,
        uint256[2] memory,
        uint256[8] memory input
    ) external view returns (bool) {
        return shouldPass && keccak256(abi.encode(input)) == expectedInputsHash;
    }
}
