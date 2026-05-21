// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ICTF} from "../interfaces/ICTF.sol";

contract MockCTF is ICTF {
    mapping(bytes32 => uint256[]) private _numerators;
    mapping(bytes32 => uint256) private _denominators;
    mapping(uint256 => mapping(address => uint256)) private _balances;

    function setPayoutNumerators(bytes32 conditionId, uint256[] calldata numerators) external {
        _numerators[conditionId] = numerators;
        emit ConditionResolution(
            conditionId,
            msg.sender,
            conditionId,        // questionId == conditionId in our mock
            numerators.length,
            numerators
        );
    }

    function setPayoutDenominator(bytes32 conditionId, uint256 denominator) external {
        _denominators[conditionId] = denominator;
    }

    function setBalance(address account, uint256 id, uint256 bal) external {
        _balances[id][account] = bal;
    }

    function payoutNumerators(bytes32 conditionId) external view returns (uint256[] memory) {
        return _numerators[conditionId];
    }

    function payoutDenominator(bytes32 conditionId) external view returns (uint256) {
        return _denominators[conditionId];
    }

    function balanceOf(address account, uint256 id) external view returns (uint256) {
        return _balances[id][account];
    }

    function redeemPositions(address, bytes32, bytes32, uint256[] calldata) external {}
}
