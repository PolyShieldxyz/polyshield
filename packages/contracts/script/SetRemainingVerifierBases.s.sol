// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Vault} from "../src/Vault.sol";
import {BetAuthG16Base} from "../src/verifiers/BetAuthVerifier.sol";
import {SettlementCreditG16Base} from "../src/verifiers/SettlementCreditVerifier.sol";
import {WithdrawalG16Base} from "../src/verifiers/WithdrawalVerifier.sol";
import {DepositG16Base} from "../src/verifiers/DepositVerifier.sol";
import {PositionCloseG16Base} from "../src/verifiers/PositionCloseVerifier.sol";
import {ConsolidateG16Base} from "../src/verifiers/ConsolidateVerifier.sol";

/// @notice Realign the on-chain VK base for the SIX non-reclaim verifiers (BET_AUTH,
/// SETTLEMENT_CREDIT, WITHDRAWAL, DEPOSIT, POSITION_CLOSE, CONSOLIDATE) after a full
/// `setup:circuits` regenerated EVERY circuit's groth16 zkey (not just the 3 reclaim circuits).
/// The frontend now serves the new zkeys, so these verifiers' OLD on-chain VKs reject the new
/// proofs with InvalidProof() (0x09bde339). This deploys the regenerated bases and points each
/// adapter at its new base via owner-only setBase() — same lever as SetReclaimVerifierBases
/// (which already handled BET_CANCEL/CANCEL_CREDIT/PARTIAL_CREDIT). Adapters/proxies unchanged;
/// public inputs unchanged; Vault unchanged.
///
/// ⚠️ The frontend must already serve the matching new zkeys (it does after the rebuild). After
/// this tx, ALL nine verifiers' on-chain VKs match the frontend artifacts again.
///
/// Required env: VAULT_ADDRESS. Broadcaster MUST be the verifier adapters' owner.
/// Usage:
///   forge script script/SetRemainingVerifierBases.s.sol --rpc-url $POLYGON_RPC_URL \
///     --account deployer --sender $DEPLOYER_ADDRESS --broadcast
interface IVerifierBaseSwap {
    function setBase(address newBase) external;
}

contract SetRemainingVerifierBases is Script {
    function run() external {
        Vault v = Vault(vm.envAddress("VAULT_ADDRESS"));
        address betAuth = v.verifiers(v.BET_AUTH());
        address settlement = v.verifiers(v.SETTLEMENT_CREDIT());
        address withdrawal = v.verifiers(v.WITHDRAWAL());
        address deposit = v.verifiers(v.DEPOSIT());
        address positionClose = v.verifiers(v.POSITION_CLOSE());
        address consolidate = v.verifiers(v.CONSOLIDATE());

        vm.startBroadcast();
        IVerifierBaseSwap(betAuth).setBase(address(new BetAuthG16Base()));
        IVerifierBaseSwap(settlement).setBase(address(new SettlementCreditG16Base()));
        IVerifierBaseSwap(withdrawal).setBase(address(new WithdrawalG16Base()));
        IVerifierBaseSwap(deposit).setBase(address(new DepositG16Base()));
        IVerifierBaseSwap(positionClose).setBase(address(new PositionCloseG16Base()));
        IVerifierBaseSwap(consolidate).setBase(address(new ConsolidateG16Base()));
        vm.stopBroadcast();

        console2.log("BET_AUTH        adapter %s rebased", betAuth);
        console2.log("SETTLEMENT      adapter %s rebased", settlement);
        console2.log("WITHDRAWAL      adapter %s rebased", withdrawal);
        console2.log("DEPOSIT         adapter %s rebased", deposit);
        console2.log("POSITION_CLOSE  adapter %s rebased", positionClose);
        console2.log("CONSOLIDATE     adapter %s rebased", consolidate);
    }
}
