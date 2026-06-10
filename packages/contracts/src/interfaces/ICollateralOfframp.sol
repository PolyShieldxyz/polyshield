// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice pUSD -> USDC conversion.
/// Deployed on Polygon: 0x2957922Eb93258b93368531d39fAcCA3B4dC5854 (verified on PolygonScan)
interface ICollateralOfframp {
    function withdraw(uint256 amount) external;
}
