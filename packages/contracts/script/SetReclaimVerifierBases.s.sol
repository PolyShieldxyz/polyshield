// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Vault} from "../src/Vault.sol";
import {BetCancelG16Base} from "../src/verifiers/BetCancelVerifier.sol";
import {CancelCreditG16Base} from "../src/verifiers/CancelCreditVerifier.sol";
import {PartialCreditG16Base} from "../src/verifiers/PartialCreditVerifier.sol";

/// @notice Swap the Groth16 VK base for the three reclaim verifiers after the bet_nonce circuit
/// redesign (decoupled reclaim). The adapter PROXIES stay the same (still registered in the
/// Vault), so this is NOT a verifier slot migration — only the underlying VK contract changes,
/// via the adapter's owner-only `setBase(address)` (instant, no timelock; separate lever from
/// proposeVerifier/acceptVerifier). Public inputs are unchanged, so the Vault needs no change.
///
/// Reads the live adapter addresses from the Vault's `verifiers(slot)` mapping, deploys the new
/// regenerated bases, and points each adapter at its new base. Broadcaster MUST be the verifier
/// adapters' owner (== deployer EOA for this test deploy).
///
/// ⚠️ Deploy in lockstep with the frontend rebuild: the new wasm/zkey produce proofs only the
/// NEW base accepts, and vice-versa. Between this tx and the frontend rollout, reclaims fail.
///
/// Required env: VAULT_ADDRESS.
/// Usage:
///   forge script script/SetReclaimVerifierBases.s.sol --rpc-url $POLYGON_RPC_URL \
///     --account deployer --sender $DEPLOYER_ADDRESS --broadcast
interface IVerifierBaseSwap {
    function setBase(address newBase) external;
}

contract SetReclaimVerifierBases is Script {
    function run() external {
        Vault vault = Vault(vm.envAddress("VAULT_ADDRESS"));
        address betCancel = vault.verifiers(vault.BET_CANCEL());
        address cancelCredit = vault.verifiers(vault.CANCEL_CREDIT());
        address partialCredit = vault.verifiers(vault.PARTIAL_CREDIT());

        vm.startBroadcast();
        address betCancelBase = address(new BetCancelG16Base());
        address cancelCreditBase = address(new CancelCreditG16Base());
        address partialCreditBase = address(new PartialCreditG16Base());

        IVerifierBaseSwap(betCancel).setBase(betCancelBase);
        IVerifierBaseSwap(cancelCredit).setBase(cancelCreditBase);
        IVerifierBaseSwap(partialCredit).setBase(partialCreditBase);
        vm.stopBroadcast();

        console2.log("BET_CANCEL     adapter %s -> base %s", betCancel, betCancelBase);
        console2.log("CANCEL_CREDIT  adapter %s -> base %s", cancelCredit, cancelCreditBase);
        console2.log("PARTIAL_CREDIT adapter %s -> base %s", partialCredit, partialCreditBase);
    }
}
