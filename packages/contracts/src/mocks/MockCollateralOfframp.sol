// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MockUSDC} from "./MockUSDC.sol";

/// @notice Local dev mock: burns pUSD from caller and mints USDC 1:1 to caller.
/// Matches the real CollateralOfframp.withdraw() behaviour — pUSD in, USDC to caller.
/// The caller (depositWallet) is then responsible for transferring USDC to the Vault.
contract MockCollateralOfframp {
    using SafeERC20 for IERC20;

    IERC20 public immutable pusd;
    MockUSDC public immutable usdc;

    constructor(address _usdc, address _pusd) {
        usdc = MockUSDC(_usdc);
        pusd = IERC20(_pusd);
    }

    /// @notice Caller must have approved this contract for `amount` pUSD.
    /// Burns pUSD from caller, mints equivalent USDC to caller (1:1).
    function withdraw(uint256 amount) external {
        pusd.safeTransferFrom(msg.sender, address(this), amount); // take pUSD
        usdc.mint(msg.sender, amount);                            // give USDC
    }
}
