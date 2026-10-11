// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {CommitmentMerkleTree} from "polyshield/CommitmentMerkleTree.sol";
import {PoseidonT3Hasher} from "polyshield/PoseidonT3Hasher.sol";

/// @notice Cross-implementation agreement between the circuits (Poseidon over BN254 as in circomlib, checked in
/// witness/differential.py against circomlibjs) and the on-chain Merkle tree / hasher, using the PRODUCTION
/// PoseidonT3 library (the repo's own tree tests use MockPoseidonT3).
///   X1  PoseidonT3Hasher.poseidon(a,b) == circomlibjs Poseidon([a,b])        (incl. 0, r-1 edge inputs)
///   X2  tree.zeros[i] == circuit-side zero-subtree values
///   X3  after every insert, tree.currentRoot == root of the reference tree whose paths the circuits consume
///   X4  folding a leaf's path with the CIRCUIT's convention (bit=1 => sibling on the left) reproduces the root,
///       and the path bits are exactly the binary expansion of the leaf index
///   X5  Vault.withdraw's recipient check  tree.hashTwo(addr, 0)  ==  circuit RecipientHash = Poseidon(addr, 0)
contract CrossLayer is Test {
    CommitmentMerkleTree tree;
    PoseidonT3Hasher hasher;
    string json;
    address vault = address(0xA11CE);

    function setUp() public {
        json = vm.readFile("crosslayer/vectors.json");
        hasher = PoseidonT3Hasher(address(new ERC1967Proxy(address(new PoseidonT3Hasher()),
            abi.encodeCall(PoseidonT3Hasher.initialize, (address(this))))));
        tree = CommitmentMerkleTree(address(new ERC1967Proxy(address(new CommitmentMerkleTree()),
            abi.encodeCall(CommitmentMerkleTree.initialize, (vault, address(hasher), address(this))))));
    }

    function _b(string memory key) internal view returns (bytes32) { return vm.parseJsonBytes32(json, key); }

    function test_X1_poseidon2_matches_circomlib() public view {
        for (uint256 i = 0; i < 30; i++) {
            string memory p = string.concat(".hash2[", vm.toString(i), "]");
            uint256 a = uint256(_b(string.concat(p, ".a")));
            uint256 b = uint256(_b(string.concat(p, ".b")));
            assertEq(bytes32(hasher.poseidon([a, b])), _b(string.concat(p, ".out")), "PoseidonT3 != circomlib");
            assertEq(tree.hashTwo(bytes32(a), bytes32(b)), _b(string.concat(p, ".out")), "tree.hashTwo != circomlib");
        }
    }

    function test_X2_zero_subtrees() public view {
        for (uint256 i = 0; i < 32; i++) {
            assertEq(tree.zeros(i), _b(string.concat(".zeros[", vm.toString(i), "]")), "zero subtree mismatch");
        }
    }

    function test_X3_X4_roots_and_paths() public {
        bytes32 last;
        for (uint256 k = 0; k < 20; k++) {
            vm.prank(vault);
            last = tree.insert(_b(string.concat(".leaves[", vm.toString(k), "]")));
            assertEq(last, _b(string.concat(".roots[", vm.toString(k), "]")), "root mismatch after insert");
            assertTrue(tree.isKnownRoot(last));
        }
        // paths are against the FINAL tree of the JS reference at insertion time of each leaf; recompute with the
        // reference tree state after all 20 leaves: use the last root
        for (uint256 k = 0; k < 20; k++) {
            bytes32 cur = _b(string.concat(".leaves[", vm.toString(k), "]"));
            for (uint256 l = 0; l < 32; l++) {
                string memory p = string.concat(".paths[", vm.toString(k), "]");
                bytes32 sib = _b(string.concat(p, ".sib[", vm.toString(l), "]"));
                uint256 bit = vm.parseJsonUint(json, string.concat(p, ".bits[", vm.toString(l), "]"));
                assertEq(bit, (k >> l) & 1, "path bit != leaf-index bit");
                // circuit: lefts = bit ? sibling : cur ; rights = bit ? cur : sibling
                cur = bit == 1 ? tree.hashTwo(sib, cur) : tree.hashTwo(cur, sib);
            }
            assertEq(cur, last, "circuit-convention path fold != on-chain root");
        }
    }

    function test_X5_recipient_hash() public view {
        for (uint256 i = 0; i < 4; i++) {
            string memory p = string.concat(".recipient[", vm.toString(i), "]");
            address a = address(uint160(uint256(_b(string.concat(p, ".addr")))));
            assertEq(tree.hashTwo(bytes32(uint256(uint160(a))), bytes32(0)), _b(string.concat(p, ".out")), "RecipientHash mismatch");
        }
    }
}
