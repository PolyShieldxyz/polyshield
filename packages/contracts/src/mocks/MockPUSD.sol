// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Mock pUSD for local redemption/offramp testing.
contract MockPUSD is ERC20 {
    constructor() ERC20("Mock pUSD", "pUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
