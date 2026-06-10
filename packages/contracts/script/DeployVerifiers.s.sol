// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Vault} from "../src/Vault.sol";
import {DeployLib} from "./DeployLib.sol";
import {BetAuthVerifier} from "../src/verifiers/BetAuthVerifier.sol";
import {SettlementCreditVerifier} from "../src/verifiers/SettlementCreditVerifier.sol";
import {WithdrawalVerifier} from "../src/verifiers/WithdrawalVerifier.sol";
import {BetCancelVerifier} from "../src/verifiers/BetCancelVerifier.sol";
import {CancelCreditVerifier} from "../src/verifiers/CancelCreditVerifier.sol";
import {DepositVerifier} from "../src/verifiers/DepositVerifier.sol";
import {PositionCloseVerifier} from "../src/verifiers/PositionCloseVerifier.sol";
import {PartialCreditVerifier} from "../src/verifiers/PartialCreditVerifier.sol";
import {ConsolidateVerifier} from "../src/verifiers/ConsolidateVerifier.sol";

/// @notice STEP 2 of the mainnet deploy (run after Deploy.s.sol). The production
/// Deploy.s.sol does NOT touch verifiers — only the local MockDeploy did, and it was
/// hardcoded to the Anvil key. This deploys all 9 Groth16 verifier adapters (each a
/// UUPS impl behind an ERC1967 proxy, owner = OWNER_ADDRESS) and PROPOSES each into its
/// Vault slot. They do not take effect until VERIFIER_TIMELOCK (48h) elapses and
/// AcceptVerifiers.s.sol is run.
///
/// proposeVerifier is onlyOwner, so the BROADCASTER MUST BE THE VAULT OWNER. For this
/// test deploy owner == deployer EOA, so the keystore account signs it directly. If the
/// owner is a multisig, do not run this script — emit the 9 proposeVerifier calls as Safe
/// transactions instead.
///
/// Required env vars: VAULT_ADDRESS, OWNER_ADDRESS
/// Signing: encrypted keystore — provide --account <name> --sender <deployerAddr>.
///
/// Usage:
///   forge script script/DeployVerifiers.s.sol --rpc-url $POLYGON_RPC_URL \
///     --account deployer --sender $DEPLOYER_ADDRESS --broadcast --verify
///
/// Output: <NAME>_VERIFIER=0x... lines for the deployment manifest.
contract DeployVerifiers is Script {
    // Contract-level storage to avoid Solidity stack-too-deep with legacy codegen.
    address internal s_betAuth;
    address internal s_settlement;
    address internal s_withdrawal;
    address internal s_betCancel;
    address internal s_cancelCredit;
    address internal s_deposit;
    address internal s_positionClose;
    address internal s_partialCredit;
    address internal s_consolidate;

    function run() external {
        address owner = vm.envAddress("OWNER_ADDRESS");
        Vault vault = Vault(vm.envAddress("VAULT_ADDRESS"));

        vm.startBroadcast();

        // Deploy each adapter impl + owned ERC1967 proxy. The proxy is what gets registered.
        s_betAuth       = DeployLib.deployOwnedProxy(address(new BetAuthVerifier()), owner);
        s_settlement    = DeployLib.deployOwnedProxy(address(new SettlementCreditVerifier()), owner);
        s_withdrawal    = DeployLib.deployOwnedProxy(address(new WithdrawalVerifier()), owner);
        s_betCancel     = DeployLib.deployOwnedProxy(address(new BetCancelVerifier()), owner);
        s_cancelCredit  = DeployLib.deployOwnedProxy(address(new CancelCreditVerifier()), owner);
        s_deposit       = DeployLib.deployOwnedProxy(address(new DepositVerifier()), owner);          // FC-2
        s_positionClose = DeployLib.deployOwnedProxy(address(new PositionCloseVerifier()), owner);    // FC-1
        s_partialCredit = DeployLib.deployOwnedProxy(address(new PartialCreditVerifier()), owner);    // FC-4
        s_consolidate   = DeployLib.deployOwnedProxy(address(new ConsolidateVerifier()), owner);      // FC-8

        // Propose into each Vault slot (onlyOwner; takes effect after the 48h timelock).
        vault.proposeVerifier(vault.BET_AUTH(),          s_betAuth);
        vault.proposeVerifier(vault.SETTLEMENT_CREDIT(), s_settlement);
        vault.proposeVerifier(vault.WITHDRAWAL(),        s_withdrawal);
        vault.proposeVerifier(vault.BET_CANCEL(),        s_betCancel);
        vault.proposeVerifier(vault.CANCEL_CREDIT(),     s_cancelCredit);
        vault.proposeVerifier(vault.DEPOSIT(),           s_deposit);
        vault.proposeVerifier(vault.POSITION_CLOSE(),    s_positionClose);
        vault.proposeVerifier(vault.PARTIAL_CREDIT(),    s_partialCredit);
        vault.proposeVerifier(vault.CONSOLIDATE(),       s_consolidate);

        vm.stopBroadcast();

        console2.log("BET_AUTH_VERIFIER=%s",       s_betAuth);
        console2.log("SETTLEMENT_VERIFIER=%s",     s_settlement);
        console2.log("WITHDRAWAL_VERIFIER=%s",     s_withdrawal);
        console2.log("BET_CANCEL_VERIFIER=%s",     s_betCancel);
        console2.log("CANCEL_CREDIT_VERIFIER=%s",  s_cancelCredit);
        console2.log("DEPOSIT_VERIFIER=%s",        s_deposit);
        console2.log("POSITION_CLOSE_VERIFIER=%s", s_positionClose);
        console2.log("PARTIAL_CREDIT_VERIFIER=%s", s_partialCredit);
        console2.log("CONSOLIDATE_VERIFIER=%s",    s_consolidate);
        console2.log("--- proposed; accept after %s seconds via AcceptVerifiers.s.sol ---", vault.VERIFIER_TIMELOCK());
    }
}
