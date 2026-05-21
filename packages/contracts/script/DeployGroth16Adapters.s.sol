// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {BetAuthGroth16Adapter} from "@groth16/adapters/BetAuthGroth16Adapter.sol";
import {SettlementCreditGroth16Adapter} from "@groth16/adapters/SettlementCreditGroth16Adapter.sol";
import {WithdrawalGroth16Adapter} from "@groth16/adapters/WithdrawalGroth16Adapter.sol";
import {BetCancelGroth16Adapter} from "@groth16/adapters/BetCancelGroth16Adapter.sol";
import {CancelCreditGroth16Adapter} from "@groth16/adapters/CancelCreditGroth16Adapter.sol";

contract DeployGroth16Adapters is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        address betAuthVerifier = vm.envAddress("BET_AUTH_GROTH16_VERIFIER");
        address settlementVerifier = vm.envAddress("SETTLEMENT_GROTH16_VERIFIER");
        address withdrawalVerifier = vm.envAddress("WITHDRAWAL_GROTH16_VERIFIER");
        address betCancelVerifier = vm.envAddress("BET_CANCEL_GROTH16_VERIFIER");
        address cancelCreditVerifier = vm.envAddress("CANCEL_CREDIT_GROTH16_VERIFIER");

        vm.startBroadcast(deployerKey);

        BetAuthGroth16Adapter betAuth = new BetAuthGroth16Adapter(betAuthVerifier);
        SettlementCreditGroth16Adapter settlement = new SettlementCreditGroth16Adapter(settlementVerifier);
        WithdrawalGroth16Adapter withdrawal = new WithdrawalGroth16Adapter(withdrawalVerifier);
        BetCancelGroth16Adapter betCancel = new BetCancelGroth16Adapter(betCancelVerifier);
        CancelCreditGroth16Adapter cancelCredit = new CancelCreditGroth16Adapter(cancelCreditVerifier);

        vm.stopBroadcast();

        console2.log("BET_AUTH_ADAPTER=%s", address(betAuth));
        console2.log("SETTLEMENT_ADAPTER=%s", address(settlement));
        console2.log("WITHDRAWAL_ADAPTER=%s", address(withdrawal));
        console2.log("BET_CANCEL_ADAPTER=%s", address(betCancel));
        console2.log("CANCEL_CREDIT_ADAPTER=%s", address(cancelCredit));
    }
}
