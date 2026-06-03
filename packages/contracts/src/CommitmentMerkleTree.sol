// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin-upgradeable/access/OwnableUpgradeable.sol";
import {IPoseidonT3} from "./interfaces/IPoseidonT3.sol";

/// @notice Append-only Poseidon Merkle tree (depth 32) with a rolling root window.
///
/// Modelled after Tornado Cash's MerkleTreeWithHistory. The contract keeps the
/// last ROOT_WINDOW roots in an O(1) `knownRoots` mapping (FC-3) so that ZK
/// proofs generated against a recent (but not current) root are still accepted.
///
/// The zero leaf is bytes32(0). Zero subtrees at each level are precomputed
/// in initialize() using the provided Poseidon hasher.
///
/// UUPS-upgradeable. STORAGE NOTE: the canonical layout is
/// `poseidon, vault, zeros[32], filledSubtrees[32], currentRoot, knownRoots,
/// rootRing, nextIndex, rootCount, __gap[20]`. This layout was intentionally
/// reset for FC-3 (root-history scaling) under the pre-mainnet test-only waiver
/// of the frozen-layout rule; the proxy is redeployed fresh. From this point on,
/// treat the layout as frozen again: never reorder, resize, or insert a variable
/// before `__gap` in any future implementation — append by shrinking `__gap`.
contract CommitmentMerkleTree is Initializable, UUPSUpgradeable, OwnableUpgradeable {
    uint32 public constant TREE_DEPTH = 32;
    /// @notice Rolling root-history window (FC-3). A proof's `merkle_root` is
    /// accepted while it is among the last ROOT_WINDOW roots. Sized for the
    /// client proving window (30s-2min ≈ 15-60 Polygon blocks) under load.
    uint32 public constant ROOT_WINDOW = 1024;

    IPoseidonT3 public poseidon; // was immutable; now proxy storage
    address public vault;        // was immutable; now proxy storage

    bytes32[TREE_DEPTH] public zeros;
    bytes32[TREE_DEPTH] public filledSubtrees;

    /// @notice The most recent root (single source of truth for the latest root).
    bytes32 public currentRoot;
    /// @notice O(1) membership: true while `root` is within the rolling window.
    /// @dev Bool flag. Roots are practically unique (strictly increasing leaf
    /// positions), so eviction-by-clear is safe. A `mapping(bytes32 => uint256)`
    /// refcount is the mainnet-hardening option if collisions are ever a concern.
    mapping(bytes32 => bool) public knownRoots;
    /// @dev Eviction ring keyed by `seq % _rootWindow()`; stores the root at each
    /// sequence position so the oldest can be un-known on overflow.
    mapping(uint256 => bytes32) private rootRing;

    uint64 public nextIndex;   // leaf counter
    uint64 public rootCount;   // # roots produced (seed counts as 1); ring sequence source

    /// @dev Reserved storage for future UUPS upgrades; see storage note above.
    uint256[20] private __gap;

    error OnlyVault();
    error TreeFull();

    event LeafInserted(uint32 indexed leafIndex, bytes32 leaf, bytes32 newRoot);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _vault, address _poseidon, address _owner) external initializer {
        __Ownable_init(_owner);
        vault = _vault;
        poseidon = IPoseidonT3(_poseidon);

        // Precompute zero subtrees. Zero leaf = bytes32(0).
        bytes32 current = bytes32(0);
        for (uint32 i = 0; i < TREE_DEPTH; i++) {
            zeros[i] = current;
            filledSubtrees[i] = current;
            current = _hash(current, current);
        }

        // Seed the initial root (all-zero tree) into all window structures.
        currentRoot = current;
        knownRoots[current] = true;
        rootRing[0] = current;
        rootCount = 1; // seed root occupies sequence 0
    }

    /// @notice UUPS upgrade authorization. Owner-gated, instant (no timelock).
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    /// @notice The rolling root-history window size. `internal virtual` so tests
    /// can override it to a tiny value to exercise eviction without inserting
    /// ROOT_WINDOW+1 leaves. Production always returns ROOT_WINDOW.
    function _rootWindow() internal view virtual returns (uint256) {
        return ROOT_WINDOW;
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    /// @notice Insert a commitment leaf and return the new root.
    function insert(bytes32 commitment) external onlyVault returns (bytes32 newRoot) {
        uint64 index = nextIndex;
        if (uint256(index) >= uint256(1) << TREE_DEPTH) revert TreeFull();
        nextIndex = index + 1;

        bytes32 current = commitment;
        uint64 idx = index;

        for (uint32 i = 0; i < TREE_DEPTH; i++) {
            if (idx % 2 == 0) {
                filledSubtrees[i] = current;
                current = _hash(current, zeros[i]);
            } else {
                current = _hash(filledSubtrees[i], current);
            }
            idx /= 2;
        }

        newRoot = current;

        // Roll the root window (FC-3). One new root is produced per insert.
        uint256 window = _rootWindow();
        uint256 seq = rootCount;
        uint256 slot = seq % window;
        if (seq >= window) {
            // Window full: the slot we are about to overwrite holds the oldest
            // root in the window. Un-know it first (collision guard so we never
            // un-know the root we are about to mark known).
            bytes32 evicted = rootRing[slot];
            if (evicted != newRoot) knownRoots[evicted] = false;
        }
        rootRing[slot] = newRoot;
        knownRoots[newRoot] = true;
        currentRoot = newRoot;
        rootCount = uint64(seq + 1);

        emit LeafInserted(uint32(index), commitment, newRoot);
    }

    /// @notice Returns true if `root` is within the last ROOT_WINDOW known roots.
    function isKnownRoot(bytes32 root) external view returns (bool) {
        if (root == bytes32(0)) return false;
        return knownRoots[root];
    }

    /// @notice Compute poseidon2(left, right). Used by Vault for recipient hash verification.
    function hashTwo(bytes32 left, bytes32 right) external view returns (bytes32) {
        return _hash(left, right);
    }

    function _hash(bytes32 left, bytes32 right) internal view returns (bytes32) {
        return bytes32(poseidon.poseidon([uint256(left), uint256(right)]));
    }
}
