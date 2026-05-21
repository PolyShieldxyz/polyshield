// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {NullifierRegistry} from "../src/NullifierRegistry.sol";
import {CommitmentMerkleTree} from "../src/CommitmentMerkleTree.sol";
import {Vault} from "../src/Vault.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockCTF} from "../src/mocks/MockCTF.sol";
import {MockPoseidonField} from "../src/mocks/MockPoseidonField.sol";
import {BetAuthGroth16Adapter} from "@groth16/adapters/BetAuthGroth16Adapter.sol";
import {SettlementCreditGroth16Adapter} from "@groth16/adapters/SettlementCreditGroth16Adapter.sol";
import {WithdrawalGroth16Adapter} from "@groth16/adapters/WithdrawalGroth16Adapter.sol";
import {BetCancelGroth16Adapter} from "@groth16/adapters/BetCancelGroth16Adapter.sol";
import {CancelCreditGroth16Adapter} from "@groth16/adapters/CancelCreditGroth16Adapter.sol";
import {MockBetAuthGroth16Verifier} from "@groth16/mocks/MockBetAuthGroth16Verifier.sol";
import {MockSettlementCreditGroth16Verifier} from "@groth16/mocks/MockSettlementCreditGroth16Verifier.sol";
import {MockWithdrawalGroth16Verifier} from "@groth16/mocks/MockWithdrawalGroth16Verifier.sol";
import {MockBetCancelGroth16Verifier} from "@groth16/mocks/MockBetCancelGroth16Verifier.sol";
import {MockCancelCreditGroth16Verifier} from "@groth16/mocks/MockCancelCreditGroth16Verifier.sol";

contract MockDeployGroth16 is Script {
    uint256 constant DEPLOYER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 constant ALICE_KEY = 0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a;
    uint256 constant BOB_KEY = 0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba;

    address constant OWNER = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    address constant OPERATOR = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address constant DEPOSIT_WALLET = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;
    address constant ALICE = 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65;
    address constant BOB = 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc;

    MockUSDC internal s_usdc;
    MockCTF internal s_ctf;
    MockPoseidonField internal s_poseidon;
    NullifierRegistry internal s_registry;
    CommitmentMerkleTree internal s_tree;
    Vault internal s_vault;
    MockBetAuthGroth16Verifier internal s_betAuthVerifier;
    MockSettlementCreditGroth16Verifier internal s_settlementVerifier;
    MockWithdrawalGroth16Verifier internal s_withdrawalVerifier;
    MockBetCancelGroth16Verifier internal s_betCancelVerifier;
    MockCancelCreditGroth16Verifier internal s_cancelCreditVerifier;
    BetAuthGroth16Adapter internal s_betAuthAdapter;
    SettlementCreditGroth16Adapter internal s_settlementAdapter;
    WithdrawalGroth16Adapter internal s_withdrawalAdapter;
    BetCancelGroth16Adapter internal s_betCancelAdapter;
    CancelCreditGroth16Adapter internal s_cancelCreditAdapter;

    bytes32 constant ALICE_COMMITMENT_1 = bytes32(uint256(1001));
    bytes32 constant BOB_COMMITMENT_1 = bytes32(uint256(1002));

    function run() external {
        _deployCore();
        _deployGroth16Verifiers();
        _seedUSDC();
        _seedDeposits();
        _log();
    }

    function _deployCore() internal {
        vm.startBroadcast(DEPLOYER_KEY);
        s_usdc = new MockUSDC();
        s_ctf = new MockCTF();
        s_poseidon = new MockPoseidonField();
        vm.stopBroadcast();

        address deployer = vm.addr(DEPLOYER_KEY);
        uint64 nonce = vm.getNonce(deployer);
        address predictedVault = vm.computeCreateAddress(deployer, nonce + 2);

        vm.startBroadcast(DEPLOYER_KEY);
        s_registry = new NullifierRegistry(predictedVault);
        s_tree = new CommitmentMerkleTree(predictedVault, address(s_poseidon));
        s_vault = new Vault(
            address(s_usdc),
            address(s_tree),
            address(s_registry),
            address(0),
            address(0),
            address(s_ctf),
            OPERATOR,
            DEPOSIT_WALLET,
            OWNER
        );
        vm.stopBroadcast();
    }

    function _deployGroth16Verifiers() internal {
        vm.startBroadcast(DEPLOYER_KEY);
        s_betAuthVerifier = new MockBetAuthGroth16Verifier();
        s_settlementVerifier = new MockSettlementCreditGroth16Verifier();
        s_withdrawalVerifier = new MockWithdrawalGroth16Verifier();
        s_betCancelVerifier = new MockBetCancelGroth16Verifier();
        s_cancelCreditVerifier = new MockCancelCreditGroth16Verifier();

        s_betAuthAdapter = new BetAuthGroth16Adapter(address(s_betAuthVerifier));
        s_settlementAdapter = new SettlementCreditGroth16Adapter(address(s_settlementVerifier));
        s_withdrawalAdapter = new WithdrawalGroth16Adapter(address(s_withdrawalVerifier));
        s_betCancelAdapter = new BetCancelGroth16Adapter(address(s_betCancelVerifier));
        s_cancelCreditAdapter = new CancelCreditGroth16Adapter(address(s_cancelCreditVerifier));

        s_vault.setVerifier(s_vault.BET_AUTH(), address(s_betAuthAdapter));
        s_vault.setVerifier(s_vault.SETTLEMENT_CREDIT(), address(s_settlementAdapter));
        s_vault.setVerifier(s_vault.WITHDRAWAL(), address(s_withdrawalAdapter));
        s_vault.setVerifier(s_vault.BET_CANCEL(), address(s_betCancelAdapter));
        s_vault.setVerifier(s_vault.CANCEL_CREDIT(), address(s_cancelCreditAdapter));
        vm.stopBroadcast();
    }

    function _seedUSDC() internal {
        vm.startBroadcast(DEPLOYER_KEY);
        s_usdc.mint(ALICE, 100_000 * 1e6);
        s_usdc.mint(BOB, 10_000 * 1e6);
        vm.stopBroadcast();
    }

    function _seedDeposits() internal {
        vm.startBroadcast(ALICE_KEY);
        s_usdc.approve(address(s_vault), type(uint256).max);
        s_vault.deposit(ALICE_COMMITMENT_1, 1_000 * 1e6);
        vm.stopBroadcast();

        vm.startBroadcast(BOB_KEY);
        s_usdc.approve(address(s_vault), type(uint256).max);
        s_vault.deposit(BOB_COMMITMENT_1, 500 * 1e6);
        vm.stopBroadcast();
    }

    function _log() internal view {
        console2.log("VAULT_ADDRESS=%s", address(s_vault));
        console2.log("BET_AUTH_VERIFIER=%s", address(s_betAuthAdapter));
        console2.log("SETTLEMENT_VERIFIER=%s", address(s_settlementAdapter));
        console2.log("WITHDRAWAL_VERIFIER=%s", address(s_withdrawalAdapter));
        console2.log("BET_CANCEL_VERIFIER=%s", address(s_betCancelAdapter));
        console2.log("CANCEL_CREDIT_VERIFIER=%s", address(s_cancelCreditAdapter));
    }
}
