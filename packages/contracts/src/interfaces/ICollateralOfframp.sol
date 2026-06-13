// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice pUSD -> USDC.e conversion (Polymarket "Permissionless Collateral Offramp").
/// Deployed on Polygon: 0x2957922Eb93258b93368531d39fAcCA3B4dC5854 (verified on PolygonScan).
/// `unwrap` (selector 0x8cc7104f) pulls `_amount` pUSD from msg.sender and sends `_amount` of
/// `_asset` (USDC.e) to `_to`, burning the pUSD. The Vault only stores this handle for reference;
/// the actual offramp is executed off-chain by the deposit wallet (signing layer), not by the Vault.
interface ICollateralOfframp {
    function unwrap(address _asset, address _to, uint256 _amount) external;
}
