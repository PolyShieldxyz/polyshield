// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MockPUSD} from "./MockPUSD.sol";
import {ICollateralOnramp} from "../interfaces/ICollateralOnramp.sol";

/// @notice Local dev mock: accepts USDC from caller and mints pUSD 1:1 back to caller.
/// Simulates the Polymarket CollateralOnramp (USDC → pUSD conversion) for testing.
contract MockCollateralOnramp is ICollateralOnramp {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    MockPUSD public immutable pusd;

    constructor(address _usdc, address _pusd) {
        usdc = IERC20(_usdc);
        pusd = MockPUSD(_pusd);
    }

    /// @notice Take USDC from caller, mint equivalent pUSD to caller (1:1).
    function deposit(uint256 amount) external override {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        pusd.mint(msg.sender, amount);
    }

    function pusdAddress() external view override returns (address) {
        return address(pusd);
    }
}
