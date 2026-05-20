// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Interface for the Gnosis Conditional Token Framework.
/// Deployed on Polygon: 0x4D97DCd97eC945f40cF65F87097ACe5EA0476045
interface ICTF {
    event ConditionResolution(
        bytes32 indexed conditionId,
        address indexed oracle,
        bytes32 indexed questionId,
        uint256 outcomeSlotCount,
        uint256[] payoutNumerators
    );

    function payoutNumerators(bytes32 conditionId) external view returns (uint256[] memory);
    function payoutDenominator(bytes32 conditionId) external view returns (uint256);
    function balanceOf(address account, uint256 id) external view returns (uint256);
    function redeemPositions(
        address collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256[] calldata indexSets
    ) external;
}
