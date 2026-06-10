// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Vault} from "../src/Vault.sol";

/// @notice Deploy a fresh Vault implementation and repoint the existing ERC1967 proxy at it
/// via UUPS `upgradeToAndCall`. Use this for logic-only changes that DO NOT alter storage
/// layout (e.g. the fundPolymarketWallet USDC-direct change — body-only, append-only storage
/// preserved). No re-initialization is performed (empty call data), so all existing state —
/// notes tree, nullifiers, fee config, AND the accepted verifier slots — is preserved. You do
/// NOT redeploy or re-accept verifiers after this upgrade.
///
/// Foundry auto-deploys and links the VaultInputs + VaultLogic libraries when it constructs
/// `new Vault()` here, exactly as in Deploy.s.sol.
///
/// `upgradeToAndCall` is gated by `_authorizeUpgrade` (onlyOwner), so the BROADCASTER MUST BE
/// THE VAULT OWNER. For this test deploy owner == deployer EOA. If the owner is a multisig,
/// deploy the impl with this script's first line, then emit the `upgradeToAndCall` as a Safe tx.
///
/// Required env: VAULT_ADDRESS (the proxy).
/// Signing: encrypted keystore — provide --account <name> --sender <ownerAddr>.
///
/// Usage:
///   forge script script/UpgradeVault.s.sol --rpc-url $POLYGON_RPC_URL \
///     --account deployer --sender $DEPLOYER_ADDRESS --broadcast
contract UpgradeVault is Script {
    function run() external {
        address proxy = vm.envAddress("VAULT_ADDRESS");

        vm.startBroadcast();
        address newImpl = address(new Vault()); // libraries auto-linked by foundry
        Vault(proxy).upgradeToAndCall(newImpl, ""); // onlyOwner; no re-init
        vm.stopBroadcast();

        console2.log("Vault proxy upgraded:", proxy);
        console2.log("new implementation: ", newImpl);
    }
}
