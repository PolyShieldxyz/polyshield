// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice USDC -> pUSD conversion.
/// Deployed on Polygon: 0x93070a847efEf7F70739046A929D47a521F5B8ee
interface ICollateralOnramp {
    function deposit(uint256 amount) external;
    function pusdAddress() external view returns (address);
}
