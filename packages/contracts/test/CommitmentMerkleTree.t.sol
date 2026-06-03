// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CommitmentMerkleTree} from "../src/CommitmentMerkleTree.sol";
import {MockPoseidonT3} from "../src/mocks/MockPoseidonT3.sol";
import {DeployLib} from "../script/DeployLib.sol";

/// @dev Test-only subclass that shrinks the root window so eviction is reachable
/// in a few inserts instead of ROOT_WINDOW+1. Exercises the exact same ring +
/// knownRoots logic as production; only the window size differs.
contract SmallWindowTree is CommitmentMerkleTree {
    function _rootWindow() internal pure override returns (uint256) {
        return 4;
    }
}

contract CommitmentMerkleTreeTest is Test {
    CommitmentMerkleTree public tree;
    MockPoseidonT3 public poseidon;
    address public vault = address(0xA11CE);
    address public attacker = address(0xBAD);

    function setUp() public {
        poseidon = new MockPoseidonT3();
        // UUPS proxy: impl + ERC1967 proxy; precompute runs in initialize().
        tree = CommitmentMerkleTree(
            DeployLib.deployProxy(
                address(new CommitmentMerkleTree()),
                abi.encodeCall(CommitmentMerkleTree.initialize, (vault, address(poseidon), address(this)))
            )
        );
    }

    function _deploySmallWindow() internal returns (CommitmentMerkleTree) {
        return CommitmentMerkleTree(
            DeployLib.deployProxy(
                address(new SmallWindowTree()),
                abi.encodeCall(CommitmentMerkleTree.initialize, (vault, address(poseidon), address(this)))
            )
        );
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

    function test_insertReturnedRootIsCurrent() public {
        bytes32 leaf = keccak256("leaf_1");
        vm.prank(vault);
        bytes32 root = tree.insert(leaf);
        // currentRoot tracks the latest insert; rootCount counts seed + 1 insert.
        assertEq(tree.currentRoot(), root);
        assertEq(tree.rootCount(), 2);
        assertEq(tree.nextIndex(), 1);
    }

    function test_currentRootTracksLatestInsert() public {
        for (uint32 i = 0; i < 5; i++) {
            bytes32 leaf = keccak256(abi.encodePacked("leaf", i));
            vm.prank(vault);
            bytes32 root = tree.insert(leaf);
            assertEq(tree.currentRoot(), root, "currentRoot must equal the latest returned root");
        }
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
    // Rolling root window (FC-3): window = ROOT_WINDOW = 1024, O(1) lookup
    // -------------------------------------------------------------------------

    /// Many more than the old 30-root window: prove the window scaled and that a
    /// root hundreds of inserts deep is still accepted (the FC-3 liveness win).
    function test_manyInsertsAllRootsKnown() public {
        uint32 n = 200; // well past the old HISTORY_SIZE of 30, well under ROOT_WINDOW
        bytes32[] memory roots = new bytes32[](n);
        for (uint32 i = 0; i < n; i++) {
            bytes32 leaf = keccak256(abi.encodePacked("leaf", i));
            vm.prank(vault);
            roots[i] = tree.insert(leaf);
        }
        for (uint32 i = 0; i < n; i++) {
            assertTrue(tree.isKnownRoot(roots[i]), "root within the window should be known");
        }
        // The very first insert's root (200 inserts ago) is still within 1024.
        assertTrue(tree.isKnownRoot(roots[0]), "root 200 inserts deep still known");
    }

    /// Eviction boundary, exercised with a tiny window (4) via SmallWindowTree.
    /// Seed occupies seq 0; insert k occupies seq k. With window 4, seq>=4 evicts
    /// the slot `seq % 4`, i.e. the root exactly 4 sequence positions older.
    function test_evictionBoundary_smallWindow() public {
        CommitmentMerkleTree small = _deploySmallWindow();
        bytes32 seedRoot = small.currentRoot();
        assertTrue(small.isKnownRoot(seedRoot), "seed root initially known");

        bytes32[] memory r = new bytes32[](5);
        for (uint32 i = 0; i < 4; i++) {
            vm.prank(vault);
            r[i] = small.insert(keccak256(abi.encodePacked("l", i)));
        }
        // After 4 inserts the window holds exactly r[0..3]; the seed (seq 0) is
        // evicted at the 4th insert (seq 4, slot 0).
        assertFalse(small.isKnownRoot(seedRoot), "seed evicted once window overflows");
        for (uint32 i = 0; i < 4; i++) {
            assertTrue(small.isKnownRoot(r[i]), "in-window root must be known");
        }

        // One more insert evicts the oldest in-window root (r[0], seq 1).
        vm.prank(vault);
        r[4] = small.insert(keccak256("l4"));
        assertFalse(small.isKnownRoot(r[0]), "oldest in-window root now evicted");
        for (uint32 i = 1; i < 5; i++) {
            assertTrue(small.isKnownRoot(r[i]), "remaining window roots known");
        }
    }

    function test_initialRootIsKnown() public view {
        // The initial all-zero tree root is the currentRoot right after init.
        assertTrue(tree.isKnownRoot(tree.currentRoot()));
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
