// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseGroth16Adapter} from "./BaseGroth16Adapter.sol";

contract CancelCreditGroth16Adapter is BaseGroth16Adapter {
    constructor(address verifier_) BaseGroth16Adapter(verifier_) {}

    function _expectedPublicInputs() internal pure override returns (uint256) {
        return 6;
    }

    function _callVerifier(
        uint256[2] memory a,
        uint256[2][2] memory b,
        uint256[2] memory c,
        bytes32[] calldata publicInputs
    ) internal view override returns (bool) {
        uint256[6] memory inputs;
        for (uint256 i = 0; i < inputs.length; i++) {
            inputs[i] = uint256(publicInputs[i]);
        }
        return _staticVerify(
            abi.encodeWithSignature(
                "verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[6])", a, b, c, inputs
            )
        );
    }
}
