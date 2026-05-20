// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice pUSD -> USDC conversion.
/// Deployed on Polygon: 0x2957922Eb93268531d39fAcCA3B4dC5854
interface ICollateralOfframp {
    function withdraw(uint256 amount) external;
}
