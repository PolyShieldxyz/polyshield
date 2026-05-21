// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVerifier} from "polyshield/interfaces/IVerifier.sol";

abstract contract BaseGroth16Adapter is IVerifier {
    uint256 internal constant BN254_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    address public immutable verifier;

    constructor(address verifier_) {
        require(verifier_ != address(0), "Groth16Adapter: verifier is zero");
        verifier = verifier_;
    }

    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view override returns (bool) {
        if (proof.length != 256) {
            return false;
        }
        if (publicInputs.length != _expectedPublicInputs()) {
            return false;
        }
        if (!_allInputsAreFieldElements(publicInputs)) {
            return false;
        }

        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) =
            abi.decode(proof, (uint256[2], uint256[2][2], uint256[2]));

        return _callVerifier(a, b, c, publicInputs);
    }

    function _expectedPublicInputs() internal pure virtual returns (uint256);

    function _callVerifier(
        uint256[2] memory a,
        uint256[2][2] memory b,
        uint256[2] memory c,
        bytes32[] calldata publicInputs
    ) internal view virtual returns (bool);

    function _allInputsAreFieldElements(bytes32[] calldata publicInputs) internal pure returns (bool) {
        for (uint256 i = 0; i < publicInputs.length; i++) {
            if (uint256(publicInputs[i]) >= BN254_SCALAR_FIELD) {
                return false;
            }
        }
        return true;
    }

    function _staticVerify(bytes memory payload) internal view returns (bool) {
        (bool success, bytes memory returndata) = verifier.staticcall(payload);
        return success && returndata.length == 32 && abi.decode(returndata, (bool));
    }
}
