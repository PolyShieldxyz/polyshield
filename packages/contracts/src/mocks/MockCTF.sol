// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ICTF} from "../interfaces/ICTF.sol";
import {MockPUSD} from "./MockPUSD.sol";

contract MockCTF is ICTF {
    mapping(bytes32 => uint256[]) private _numerators;
    mapping(bytes32 => uint256) private _denominators;
    mapping(uint256 => mapping(address => uint256)) private _balances;

    MockPUSD public immutable pusd;

    constructor(address _pusd) {
        pusd = MockPUSD(_pusd);
    }

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

    /// @notice Called by mock CLOB when a FOK order fills — credits CTF shares to account.
    function mintShares(address account, uint256 id, uint256 amount) external {
        _balances[id][account] += amount;
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

    /// @notice Burns caller's CTF shares and mints pUSD payout to caller.
    /// Each indexSet bit k corresponds to outcome slot k; payout is
    /// sharesHeld * numerators[k] / denominator for each winning slot.
    function redeemPositions(
        address collateralToken,
        bytes32,
        bytes32 conditionId,
        uint256[] calldata indexSets
    ) external {
        uint256[] memory numerators = _numerators[conditionId];
        uint256 denominator = _denominators[conditionId];
        if (denominator == 0) return;

        uint256 totalPayout = 0;
        for (uint256 s = 0; s < indexSets.length; s++) {
            uint256 indexSet = indexSets[s];
            uint256 sharesHeld = _balances[indexSet][msg.sender];
            if (sharesHeld == 0) continue;

            uint256 positionPayout = 0;
            for (uint256 k = 0; k < numerators.length; k++) {
                // forge-lint: disable-next-line(incorrect-shift)
                if (indexSet & (1 << k) != 0 && numerators[k] > 0) {
                    positionPayout += sharesHeld * numerators[k] / denominator;
                }
            }
            _balances[indexSet][msg.sender] = 0; // burn shares
            totalPayout += positionPayout;
        }

        if (totalPayout > 0) {
            // Mint pUSD to caller — collateralToken param is ignored in mock (always pUSD).
            // In production, CTF burns caller's positions and transfers collateralToken.
            (collateralToken); // silence unused-param warning
            pusd.mint(msg.sender, totalPayout);
        }
    }
}
