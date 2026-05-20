// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {NullifierRegistry} from "../src/NullifierRegistry.sol";

contract NullifierRegistryTest is Test {
    NullifierRegistry public registry;
    address public vault = address(0xA11CE);
    address public attacker = address(0xBAD);

    bytes32 constant NULLIFIER = keccak256("test_nullifier");

    function setUp() public {
        registry = new NullifierRegistry(vault);
    }

    function test_initiallyNotSpent() public view {
        assertFalse(registry.isSpent(NULLIFIER));
    }

    function test_markSpent() public {
        vm.prank(vault);
        registry.markSpent(NULLIFIER);
        assertTrue(registry.isSpent(NULLIFIER));
    }

    function test_revert_doubleSpend() public {
        vm.prank(vault);
        registry.markSpent(NULLIFIER);
        vm.prank(vault);
        vm.expectRevert(NullifierRegistry.AlreadySpent.selector);
        registry.markSpent(NULLIFIER);
    }

    function test_revert_onlyVault() public {
        vm.prank(attacker);
        vm.expectRevert(NullifierRegistry.OnlyVault.selector);
        registry.markSpent(NULLIFIER);
    }

    function test_differentNullifiersIndependent() public {
        bytes32 n2 = keccak256("other_nullifier");
        vm.prank(vault);
        registry.markSpent(NULLIFIER);
        assertFalse(registry.isSpent(n2));
    }
}
