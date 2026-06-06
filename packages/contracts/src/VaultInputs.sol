// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVerifier} from "./interfaces/IVerifier.sol";

// =============================================================================
// Public-input structs — mirror each circuit's `pub` parameter list in order.
// Defined at file scope (not inside the Vault) so both the Vault and the
// VaultInputs library can reference them. Moving them here does NOT change the
// Vault's external ABI: each struct's canonical tuple type is unchanged.
// =============================================================================

struct BetAuthPublicInputs {
    bytes32 merkle_root;
    bytes32 nullifier;
    bytes32 new_commitment;
    uint64 bet_amount;
    uint64 price;
    uint64 expected_shares;
    bytes32 market_id;
    uint8 outcome_side;
    bytes32 position_id;
}

struct SettlementPublicInputs {
    bytes32 merkle_root;
    bytes32 nullifier;
    bytes32 new_commitment;
    bytes32 nullifier_of_bet;
    bytes32 market_id;
    // payout_per_share REMOVED — read from pendingCredit[market_id]
    // shares_held is NOT here — injected from betRecords[nullifier_of_bet]
    uint64 total_credit;
}

struct WithdrawalPublicInputs {
    bytes32 merkle_root;
    bytes32 nullifier;
    uint64 withdrawal_amount;
    bytes32 recipient_hash;
    bytes32 new_commitment;
}

struct BetCancelPublicInputs {
    bytes32 merkle_root;
    bytes32 nullifier;
    bytes32 new_commitment;
    bytes32 nullifier_of_bet;
    // bet_amount is NOT here — it is injected from betRecords[nullifier_of_bet]
}

struct NACancelPublicInputs {
    bytes32 merkle_root;
    bytes32 nullifier;
    bytes32 new_commitment;
    bytes32 nullifier_of_bet;
    bytes32 market_id;
    // bet_amount is NOT here — it is injected from betRecords[nullifier_of_bet]
}

struct ClosePublicInputs {
    bytes32 merkle_root;
    bytes32 nullifier;
    bytes32 new_commitment;
    bytes32 nullifier_of_bet;
    // sell_proceeds is NOT here — injected from betRecords[nullifier_of_bet].sell_proceeds (FC-1)
}

struct PartialFillPublicInputs {
    bytes32 merkle_root;
    bytes32 nullifier;
    bytes32 new_commitment;
    bytes32 nullifier_of_bet;
    // refund_amount is NOT here — injected as (bet_amount - spent_amount) from betRecords (FC-4)
}

struct ConsolidatePublicInputs {
    bytes32 merkle_root;
    bytes32[4] nullifier;   // FC-8: one per input slot; inactive slots are bytes32(0)
    bytes32 new_commitment; // merged note continuing slot 0's lineage
}

/// @notice Builds each circuit's public-signal array (in declaration order) AND dispatches the
/// verifier call. Extracted from the Vault into an external library (deployed once and
/// DELEGATECALL-linked) purely to keep the Vault under the 24576-byte EIP-170 limit. Folding the
/// `IVerifier.verify` staticcall in here (rather than only the array assembly) moves the most
/// bytecode out of the Vault. The functions are `view`, touch no storage, and the Vault keeps
/// injecting the trailing Vault-authoritative values (fee / bet_amount / sell_proceeds /
/// refund_amount) exactly as before — behaviour is identical to the former in-contract helpers.
library VaultInputs {
    /// @dev Deposit binding (FC-2): [commitment, amount, owner_address].
    function verifyDeposit(address verifier, bytes calldata proof, bytes32 commitment, uint256 amount, address owner)
        external
        view
        returns (bool)
    {
        bytes32[] memory p = new bytes32[](3);
        p[0] = commitment;
        p[1] = bytes32(amount);
        p[2] = bytes32(uint256(uint160(owner)));
        return IVerifier(verifier).verify(proof, p);
    }

    /// @dev Bet auth: [merkle_root, nullifier, new_commitment, bet_amount, price,
    /// expected_shares, market_id, outcome_side, position_id, fee]. `fee` is Vault-injected.
    function verifyBetAuth(address verifier, bytes calldata proof, BetAuthPublicInputs calldata i, uint64 fee)
        external
        view
        returns (bool)
    {
        bytes32[] memory p = new bytes32[](10);
        p[0] = i.merkle_root;
        p[1] = i.nullifier;
        p[2] = i.new_commitment;
        p[3] = bytes32(uint256(i.bet_amount));
        p[4] = bytes32(uint256(i.price));
        p[5] = bytes32(uint256(i.expected_shares));
        p[6] = i.market_id;
        p[7] = bytes32(uint256(i.outcome_side));
        p[8] = i.position_id;
        p[9] = bytes32(uint256(fee)); // FEE: Vault-injected protocol fee + relay-gas reimbursement
        return IVerifier(verifier).verify(proof, p);
    }

    function verifySettlement(address verifier, bytes calldata proof, SettlementPublicInputs calldata i)
        external
        view
        returns (bool)
    {
        bytes32[] memory p = new bytes32[](6);
        p[0] = i.merkle_root;
        p[1] = i.nullifier;
        p[2] = i.new_commitment;
        p[3] = i.nullifier_of_bet;
        p[4] = i.market_id;
        p[5] = bytes32(uint256(i.total_credit));
        return IVerifier(verifier).verify(proof, p);
    }

    function verifyWithdrawal(address verifier, bytes calldata proof, WithdrawalPublicInputs calldata i)
        external
        view
        returns (bool)
    {
        bytes32[] memory p = new bytes32[](5);
        p[0] = i.merkle_root;
        p[1] = i.nullifier;
        p[2] = bytes32(uint256(i.withdrawal_amount));
        p[3] = i.recipient_hash;
        p[4] = i.new_commitment;
        return IVerifier(verifier).verify(proof, p);
    }

    function verifyBetCancel(address verifier, bytes calldata proof, BetCancelPublicInputs calldata i, uint64 bet_amount)
        external
        view
        returns (bool)
    {
        bytes32[] memory p = new bytes32[](5);
        p[0] = i.merkle_root;
        p[1] = i.nullifier;
        p[2] = i.new_commitment;
        p[3] = i.nullifier_of_bet;
        p[4] = bytes32(uint256(bet_amount)); // Vault-injected; uint64 -> uint256 -> bytes32
        return IVerifier(verifier).verify(proof, p);
    }

    function verifyNACancel(address verifier, bytes calldata proof, NACancelPublicInputs calldata i, uint64 bet_amount)
        external
        view
        returns (bool)
    {
        bytes32[] memory p = new bytes32[](6);
        p[0] = i.merkle_root;
        p[1] = i.nullifier;
        p[2] = i.new_commitment;
        p[3] = i.nullifier_of_bet;
        p[4] = i.market_id;
        p[5] = bytes32(uint256(bet_amount)); // Vault-injected; uint64 -> uint256 -> bytes32
        return IVerifier(verifier).verify(proof, p);
    }

    function verifyClose(address verifier, bytes calldata proof, ClosePublicInputs calldata i, uint64 sell_proceeds)
        external
        view
        returns (bool)
    {
        bytes32[] memory p = new bytes32[](5);
        p[0] = i.merkle_root;
        p[1] = i.nullifier;
        p[2] = i.new_commitment;
        p[3] = i.nullifier_of_bet;
        p[4] = bytes32(uint256(sell_proceeds)); // Vault-injected; uint64 -> uint256 -> bytes32
        return IVerifier(verifier).verify(proof, p);
    }

    function verifyPartialCredit(address verifier, bytes calldata proof, PartialFillPublicInputs calldata i, uint64 refund_amount)
        external
        view
        returns (bool)
    {
        bytes32[] memory p = new bytes32[](5);
        p[0] = i.merkle_root;
        p[1] = i.nullifier;
        p[2] = i.new_commitment;
        p[3] = i.nullifier_of_bet;
        p[4] = bytes32(uint256(refund_amount)); // Vault-injected; uint64 -> uint256 -> bytes32
        return IVerifier(verifier).verify(proof, p);
    }

    /// @dev Consolidate (FC-8): [merkle_root, nullifier[0..3], new_commitment] = 6.
    function verifyConsolidate(address verifier, bytes calldata proof, ConsolidatePublicInputs calldata i)
        external
        view
        returns (bool)
    {
        bytes32[] memory p = new bytes32[](6);
        p[0] = i.merkle_root;
        p[1] = i.nullifier[0];
        p[2] = i.nullifier[1];
        p[3] = i.nullifier[2];
        p[4] = i.nullifier[3];
        p[5] = i.new_commitment;
        return IVerifier(verifier).verify(proof, p);
    }
}
