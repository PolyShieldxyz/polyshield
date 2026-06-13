// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MockUSDC} from "./MockUSDC.sol";

/// @notice Local dev mock mirroring the real Polymarket CollateralOfframp ABI:
/// `unwrap(address _asset, address _to, uint256 _amount)` (selector 0x8cc7104f) — pulls `_amount`
/// pUSD from msg.sender (the deposit wallet) and sends `_amount` of `_asset` (USDC) to `_to`, 1:1.
/// Matches production so the local settlement/reclaim path exercises the real call.
contract MockCollateralOfframp {
    using SafeERC20 for IERC20;

    IERC20 public immutable pusd;
    MockUSDC public immutable usdc;

    constructor(address _usdc, address _pusd) {
        usdc = MockUSDC(_usdc);
        pusd = IERC20(_pusd);
    }

    /// @notice Caller must have approved this contract for `_amount` pUSD.
    /// Burns pUSD from msg.sender, mints equivalent USDC (1:1) to `_to`. `_asset` is the USDC
    /// address in production; the mock has a single USDC so it is accepted and unused.
    function unwrap(address _asset, address _to, uint256 _amount) external {
        _asset; // unused in the single-collateral mock; present to match the real signature
        pusd.safeTransferFrom(msg.sender, address(this), _amount); // take pUSD from caller
        usdc.mint(_to, _amount);                                   // give USDC to _to
    }
}
