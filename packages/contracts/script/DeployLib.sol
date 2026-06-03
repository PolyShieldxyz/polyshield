// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Vault} from "../src/Vault.sol";

/// @notice Shared helper for deploying ERC1967 / UUPS proxies from Foundry scripts
/// and tests. Keeps the cyclic-dependency `computeCreateAddress` prediction trick in
/// one place (see Deploy.s.sol / MockDeploy.s.sol) and avoids duplicating proxy
/// boilerplate across deploy scripts and the test harness.
library DeployLib {
    /// @dev Vault.initialize arguments bundled into a memory struct. Passing this as a
    /// single pointer (rather than 9 stack values) keeps callers under the legacy-codegen
    /// stack limit without needing `via_ir`.
    struct VaultInit {
        address usdc;
        address tree;
        address registry;
        address onramp;
        address offramp;
        address ctf;
        address operator;
        address depositWallet;
        address owner;
    }

    /// @dev Deploy the Vault behind an ERC1967 proxy, initialized atomically. The 9-arg
    /// `abi.encodeCall(Vault.initialize, ...)` tuple is built inside this frame, so the
    /// call site only ever holds the impl address + the struct pointer.
    function deployVaultProxy(address impl, VaultInit memory v) internal returns (address) {
        return deployProxy(
            impl,
            abi.encodeCall(
                Vault.initialize,
                (v.usdc, v.tree, v.registry, v.onramp, v.offramp, v.ctf, v.operator, v.depositWallet, v.owner)
            )
        );
    }

    /// @dev Deploy an ERC1967 proxy pointing at `impl`, atomically executing `initData`
    /// (typically `abi.encodeCall(Impl.initialize, (...))`) in the proxy's storage context.
    /// Front-run-safe: initialization runs inside the proxy constructor, so there is no
    /// window in which an attacker can call `initialize` first. The `new` executes from
    /// the caller (the broadcasting EOA in scripts, `address(this)` in tests), so callers
    /// can predict the resulting address with `vm.computeCreateAddress`.
    function deployProxy(address impl, bytes memory initData) internal returns (address) {
        return address(new ERC1967Proxy(impl, initData));
    }

    /// @dev Convenience for the verifiers and the Poseidon hasher, whose initializer is
    /// uniformly `initialize(address owner)`. Selector is identical across all of them.
    function deployOwnedProxy(address impl, address owner) internal returns (address) {
        return deployProxy(impl, abi.encodeWithSignature("initialize(address)", owner));
    }
}
