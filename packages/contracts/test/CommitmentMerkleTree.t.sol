// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CommitmentMerkleTree} from "../src/CommitmentMerkleTree.sol";
import {MockPoseidonT3} from "../src/mocks/MockPoseidonT3.sol";

contract CommitmentMerkleTreeTest is Test {
    CommitmentMerkleTree public tree;
    MockPoseidonT3 public poseidon;
    address public vault = address(0xA11CE);
    address public attacker = address(0xBAD);

    function setUp() public {
        poseidon = new MockPoseidonT3();
        tree = new CommitmentMerkleTree(vault, address(poseidon));
    }

    // -------------------------------------------------------------------------
    // Basic insert
    // -------------------------------------------------------------------------

    function test_singleInsert() public {
        bytes32 leaf = keccak256("leaf_1");
        vm.prank(vault);
        bytes32 root = tree.insert(leaf);
        assertNotEq(root, bytes32(0));
        assertTrue(tree.isKnownRoot(root));
        assertEq(tree.nextIndex(), 1);
    }

    function test_insertReturnedRootIsStored() public {
        bytes32 leaf = keccak256("leaf_1");
        vm.prank(vault);
        bytes32 root = tree.insert(leaf);
        // currentRootIndex should have advanced to 1 (slot 0 is initial empty root)
        assertEq(tree.currentRootIndex(), 1);
        assertEq(tree.recentRoots(1), root);
    }

    function test_twoInsertsDifferentRoots() public {
        bytes32 leaf1 = keccak256("leaf_1");
        bytes32 leaf2 = keccak256("leaf_2");
        vm.prank(vault);
        bytes32 root1 = tree.insert(leaf1);
        vm.prank(vault);
        bytes32 root2 = tree.insert(leaf2);
        assertNotEq(root1, root2);
        assertTrue(tree.isKnownRoot(root1));
        assertTrue(tree.isKnownRoot(root2));
    }

    // -------------------------------------------------------------------------
    // Rolling root window
    // -------------------------------------------------------------------------

    function test_30InsertsAllRootsKnown() public {
        bytes32[] memory roots = new bytes32[](30);
        for (uint32 i = 0; i < 30; i++) {
            bytes32 leaf = keccak256(abi.encodePacked("leaf", i));
            vm.prank(vault);
            roots[i] = tree.insert(leaf);
        }
        for (uint32 i = 0; i < 30; i++) {
            assertTrue(tree.isKnownRoot(roots[i]), "root should be known");
        }
    }

    function test_31stInsertEvictsOldestRoot() public {
        // HISTORY_SIZE = 30; slot 0 is the initial empty-tree root
        // After 30 inserts the ring wraps; the 31st insert overwrites slot 1
        // which held the root after the 1st insert. So that root gets evicted.

        bytes32 firstInsertRoot;
        for (uint32 i = 0; i < 31; i++) {
            bytes32 leaf = keccak256(abi.encodePacked("leaf", i));
            vm.prank(vault);
            bytes32 r = tree.insert(leaf);
            if (i == 0) firstInsertRoot = r;
        }
        // firstInsertRoot was stored at slot 1; after 30 more writes it wraps back
        assertFalse(tree.isKnownRoot(firstInsertRoot), "oldest root should be evicted");
    }

    function test_initialRootIsKnown() public view {
        // The initial all-zero tree root stored at slot 0 should be known
        bytes32 initialRoot = tree.recentRoots(0);
        assertTrue(tree.isKnownRoot(initialRoot));
    }

    function test_zeroRootReturnsFalse() public view {
        assertFalse(tree.isKnownRoot(bytes32(0)));
    }

    // -------------------------------------------------------------------------
    // Access control
    // -------------------------------------------------------------------------

    function test_revert_onlyVaultInsert() public {
        vm.prank(attacker);
        vm.expectRevert(CommitmentMerkleTree.OnlyVault.selector);
        tree.insert(keccak256("leaf"));
    }

    // -------------------------------------------------------------------------
    // hashTwo exposed for Vault recipient check
    // -------------------------------------------------------------------------

    function test_hashTwoDeterministic() public view {
        bytes32 a = bytes32(uint256(1));
        bytes32 b = bytes32(uint256(0));
        bytes32 h1 = tree.hashTwo(a, b);
        bytes32 h2 = tree.hashTwo(a, b);
        assertEq(h1, h2);
    }

    function test_hashTwoNotCommutative() public view {
        bytes32 a = bytes32(uint256(1));
        bytes32 b = bytes32(uint256(2));
        assertNotEq(tree.hashTwo(a, b), tree.hashTwo(b, a));
    }
}
