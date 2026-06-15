// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {CommitmentMerkleTree} from "./CommitmentMerkleTree.sol";
import {NullifierRegistry} from "./NullifierRegistry.sol";
import {ICTF} from "./interfaces/ICTF.sol";
import {
    VaultInputs,
    BetStatus,
    BetRecord,
    OperatorAttestation,
    SettlementPublicInputs,
    BetCancelPublicInputs,
    NACancelPublicInputs,
    ClosePublicInputs,
    PartialFillPublicInputs,
    ConsolidatePublicInputs
} from "./VaultInputs.sol";

/// @notice External (DELEGATECALL-linked) library holding the bulkier Vault spend-path
/// function bodies so the Vault stays under the EIP-170 24576-byte runtime limit. Linked
/// like VaultInputs: every function runs in the Vault's storage/context, so external calls
/// (tree/nullifiers/ctf/verifiers) carry msg.sender == Vault, and emitted events are logged
/// with the Vault's address (same topic — external indexers are unaffected). Contract handles
/// are passed BY VALUE (in `Ctx`); only the Vault's own mappings are passed as `storage` refs.
///
/// The Vault keeps the thin external wrappers (which carry nonReentrant/whenNotPaused — those
/// touch Vault state) plus its own ABI-level event declarations; the logic lives here.
library VaultLogic {
    // BN254 scalar field prime — must match Vault.BN254_P and the circuit field.
    uint256 private constant BN254_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // FC-9 EIP-712 type hash — must match Vault.OPERATOR_ATTESTATION_TYPEHASH.
    bytes32 private constant OPERATOR_ATTESTATION_TYPEHASH =
        keccak256("OperatorAttestation(bytes32 nullifierOfBet,uint8 reportType,uint64 amountA,uint64 amountB)");
    // Report-type constants — must match the Vault's.
    uint8 private constant REPORT_FILLED = 1;
    uint8 private constant REPORT_FAILED = 2;
    uint8 private constant REPORT_PARTIAL = 3;
    uint8 private constant REPORT_SOLD = 4;

    // Errors (same signatures => same selectors as the Vault's, so existing tests/abis match).
    error UnknownRoot();
    error NullifierSpent();
    error InvalidProof();
    error BetNotFound();
    error WrongMarket();
    error BetNotFilled();
    error MarketNotResolved();
    error BetNotFailed();
    error BetNotCancellable();
    error ConditionNotRegistered();
    error ConditionNotResolved();
    error NotNA();
    error BetNotClosing();
    error InvalidSoldShares();
    error CannotCloseResolvedMarket();
    error BetNotPartialFilled();
    error InvalidFilledShares();
    error InvalidSpentAmount();
    error NonMonotonicProceeds();
    error AlreadyPartiallyClosed();
    error AttestationMismatch();
    error InvalidAttestation();
    error EmptyConsolidation();

    // Events re-declared here for emission; the Vault keeps its own declarations for ABI.
    event SettlementCredited(bytes32 indexed nullifier, bytes32 nullifier_of_bet, bytes32 new_commitment);
    event BetCancellationCredited(bytes32 indexed nullifier, bytes32 nullifier_of_bet, bytes32 new_commitment);
    event NACancellationCredited(bytes32 indexed nullifier, bytes32 nullifier_of_bet, bytes32 new_commitment);
    event BetSold(bytes32 indexed nullifier_of_bet, uint64 sold_shares, uint64 proceeds);
    event PositionClosed(bytes32 indexed nullifier, bytes32 nullifier_of_bet, bytes32 new_commitment, bool fullClose);
    event PartialFillCredited(bytes32 indexed nullifier, bytes32 nullifier_of_bet, bytes32 new_commitment);
    event Consolidated(bytes32[4] nullifiers, bytes32 new_commitment);

    /// Common handles bundled so each spend-path function takes one struct instead of four args.
    struct Ctx {
        CommitmentMerkleTree tree;
        NullifierRegistry nullifiers;
        address operator;        // signingLayerOperator
        bytes32 domainSeparator; // EIP-712 domain separator for attestation verification
    }

    // ── shared helpers (internal — inlined into each external fn) ─────────────────────────────

    function _circuitKey(bytes32 conditionId) private pure returns (bytes32) {
        return bytes32(uint256(conditionId) % BN254_P);
    }

    function _requireUnspentKnownRoot(Ctx memory ctx, bytes32 nullifier, bytes32 root) private view {
        if (ctx.nullifiers.isSpent(nullifier)) revert NullifierSpent();
        if (!ctx.tree.isKnownRoot(root)) revert UnknownRoot();
    }

    function _spendAndInsert(Ctx memory ctx, bytes32 nullifier, bytes32 commitment) private {
        ctx.nullifiers.markSpent(nullifier);
        if (commitment != bytes32(0)) ctx.tree.insert(commitment);
    }

    /// FC-9: verify an attestation bound to `nob` whose reportType is in {primaryType, altType}.
    function _checkAttestation(
        Ctx memory ctx,
        OperatorAttestation calldata att,
        bytes calldata sig,
        bytes32 nob,
        uint8 primaryType,
        uint8 altType
    ) private view {
        if (att.nullifierOfBet != nob) revert AttestationMismatch();
        if (att.reportType != primaryType && att.reportType != altType) revert AttestationMismatch();
        bytes32 structHash = keccak256(
            abi.encode(OPERATOR_ATTESTATION_TYPEHASH, att.nullifierOfBet, att.reportType, att.amountA, att.amountB)
        );
        bytes32 digest = MessageHashUtils.toTypedDataHash(ctx.domainSeparator, structHash);
        if (ECDSA.recover(digest, sig) != ctx.operator) revert InvalidAttestation();
    }

    // ── spend-path function bodies ──────────────────────────────────────────────────────────

    function creditSettlement(
        Ctx memory ctx,
        mapping(bytes32 => BetRecord) storage betRecords,
        mapping(bytes32 => mapping(uint8 => uint64)) storage pendingCredit,
        mapping(bytes32 => uint64) storage marketResolvedAt,
        address verifier,
        bytes calldata proof,
        SettlementPublicInputs calldata inputs,
        OperatorAttestation calldata att,
        bytes calldata sig
    ) external {
        _requireUnspentKnownRoot(ctx, inputs.nullifier, inputs.merkle_root);

        BetRecord storage rec = betRecords[inputs.nullifier_of_bet];
        if (rec.market_id == bytes32(0)) revert BetNotFound();
        if (rec.market_id != inputs.market_id) revert WrongMarket();
        if (rec.status != BetStatus.FILLED) {
            if (rec.status != BetStatus.ACTIVE) revert BetNotFilled();
            _checkAttestation(ctx, att, sig, inputs.nullifier_of_bet, REPORT_FILLED, REPORT_FILLED);
        }

        bytes32 circuit_key = _circuitKey(inputs.market_id);
        if (marketResolvedAt[circuit_key] == 0) revert MarketNotResolved();
        uint64 payout_per_share = pendingCredit[circuit_key][rec.outcome_side];

        // Settle only the UNSOLD remainder: a partial close (FC-1) recorded rec.sold_shares and already
        // credited their proceeds, so those shares no longer settle. sold_shares == 0 for un-closed bets
        // (behavior unchanged) and the close gate guarantees sold_shares <= expected_shares.
        uint64 shares_held = rec.expected_shares - rec.sold_shares;
        require(uint256(shares_held) * uint256(payout_per_share) == uint256(inputs.total_credit), "Invalid total_credit");

        if (!VaultInputs.verifySettlement(verifier, proof, inputs)) revert InvalidProof();

        _spendAndInsert(ctx, inputs.nullifier, inputs.new_commitment);
        rec.status = BetStatus.CREDITED;

        emit SettlementCredited(inputs.nullifier, inputs.nullifier_of_bet, inputs.new_commitment);
    }

    function betCancellationCredit(
        Ctx memory ctx,
        mapping(bytes32 => BetRecord) storage betRecords,
        mapping(bytes32 => uint64) storage betProtocolFee,
        address verifier,
        bytes calldata proof,
        BetCancelPublicInputs calldata inputs,
        OperatorAttestation calldata att,
        bytes calldata sig
    ) external {
        _requireUnspentKnownRoot(ctx, inputs.nullifier, inputs.merkle_root);

        BetRecord storage rec = betRecords[inputs.nullifier_of_bet];
        if (rec.market_id == bytes32(0)) revert BetNotFound();
        if (rec.status != BetStatus.FAILED) {
            if (rec.status != BetStatus.ACTIVE) revert BetNotFailed();
            _checkAttestation(ctx, att, sig, inputs.nullifier_of_bet, REPORT_FAILED, REPORT_FAILED);
        }

        // FC-14: a cancelled bet never executed, so refund the stake AND the full protocol fee
        // (the relay-gas fee is kept — it was a real submission cost). The circuit credits the
        // Vault-injected amount; the frontend/recovery compute the identical value. feeAccumulator is
        // NOT touched — the protocol fee was provisional (never claimable), so there's nothing to
        // decrement; we just clear the provisional entry.
        uint64 refund_amount = rec.bet_amount + betProtocolFee[inputs.nullifier_of_bet];
        if (!VaultInputs.verifyBetCancel(verifier, proof, inputs, refund_amount)) revert InvalidProof();

        _spendAndInsert(ctx, inputs.nullifier, inputs.new_commitment);
        rec.status = BetStatus.CANCELLED_CREDITED;
        betProtocolFee[inputs.nullifier_of_bet] = 0; // provisional fee fully refunded

        emit BetCancellationCredited(inputs.nullifier, inputs.nullifier_of_bet, inputs.new_commitment);
    }

    function naCancellationCredit(
        Ctx memory ctx,
        mapping(bytes32 => BetRecord) storage betRecords,
        mapping(bytes32 => bytes32) storage conditionIdOf,
        ICTF ctf,
        address verifier,
        bytes calldata proof,
        NACancelPublicInputs calldata inputs,
        OperatorAttestation calldata att,
        bytes calldata sig
    ) external {
        _requireUnspentKnownRoot(ctx, inputs.nullifier, inputs.merkle_root);

        BetRecord storage rec = betRecords[inputs.nullifier_of_bet];
        if (rec.market_id == bytes32(0)) revert BetNotFound();
        if (rec.market_id != inputs.market_id) revert WrongMarket();
        if (rec.status != BetStatus.FILLED && rec.status != BetStatus.FAILED) {
            if (rec.status != BetStatus.ACTIVE) revert BetNotCancellable();
            _checkAttestation(ctx, att, sig, inputs.nullifier_of_bet, REPORT_FILLED, REPORT_FAILED);
        }
        // FC-1: a position that was (partially) closed already took sale proceeds; refunding the full
        // bet_amount on an N/A market would double-pay. Block it (v1 conservative — the unsold
        // remainder's stake refund is forfeited; a pro-rata refund is a future change).
        if (rec.sold_shares > 0) revert AlreadyPartiallyClosed();
        // FC-11: inputs.market_id is the field-safe circuit_key (lossy); use the real conditionId
        // the operator registered (resolveMarket / registerCondition). Reduce first to match.
        bytes32 realConditionId = conditionIdOf[_circuitKey(inputs.market_id)];
        if (realConditionId == bytes32(0)) revert ConditionNotRegistered();

        uint256 denominator = ctf.payoutDenominator(realConditionId);
        if (denominator == 0) revert ConditionNotResolved();

        // Read payouts element-by-index from the real CTF (no array getter exists on-chain — see ICTF).
        uint256 slotCount = ctf.getOutcomeSlotCount(realConditionId);
        for (uint256 i = 0; i < slotCount; i++) {
            if (ctf.payoutNumerators(realConditionId, i) != 0) revert NotNA();
        }

        if (!VaultInputs.verifyNACancel(verifier, proof, inputs, rec.bet_amount)) revert InvalidProof();

        _spendAndInsert(ctx, inputs.nullifier, inputs.new_commitment);
        rec.status = BetStatus.CANCELLED_CREDITED;

        emit NACancellationCredited(inputs.nullifier, inputs.nullifier_of_bet, inputs.new_commitment);
    }

    /// @return fullClose true when this close fully exits the position (terminal) — the caller then
    /// releases the bet's provisional protocol fee as earned (FC-14).
    function closePosition(
        Ctx memory ctx,
        mapping(bytes32 => BetRecord) storage betRecords,
        mapping(bytes32 => uint64) storage marketResolvedAt,
        address verifier,
        bytes calldata proof,
        ClosePublicInputs calldata inputs,
        OperatorAttestation calldata att,
        bytes calldata sig
    ) external returns (bool fullClose) {
        _requireUnspentKnownRoot(ctx, inputs.nullifier, inputs.merkle_root);

        BetRecord storage rec = betRecords[inputs.nullifier_of_bet];
        if (rec.market_id == bytes32(0)) revert BetNotFound();
        if (rec.status != BetStatus.ACTIVE && rec.status != BetStatus.FILLED) revert BetNotClosing();
        _checkAttestation(ctx, att, sig, inputs.nullifier_of_bet, REPORT_SOLD, REPORT_SOLD);
        // FC-1 (partial-close aware): att.amountA is the CUMULATIVE shares sold for this position and
        // att.amountB the cumulative proceeds. Require strictly more sold than already recorded — this
        // both rejects replay of a persisted SOLD (a re-submit has amountA == rec.sold_shares) and caps
        // the close at the original position. A full close (amountA == expected_shares) is terminal;
        // a partial leaves the record FILLED so the unsold remainder still settles at resolution.
        if (att.amountA <= rec.sold_shares || att.amountA > rec.expected_shares) revert InvalidSoldShares();
        if (att.amountB < rec.sell_proceeds) revert NonMonotonicProceeds();
        if (marketResolvedAt[_circuitKey(rec.market_id)] != 0) revert CannotCloseResolvedMarket();

        // Credit only the NEW proceeds (cumulative − already-credited). For the first/only close
        // rec.sell_proceeds == 0, so credit == att.amountB (identical to the prior full-only design).
        uint64 credit = att.amountB - rec.sell_proceeds;
        if (!VaultInputs.verifyClose(verifier, proof, inputs, credit)) revert InvalidProof();

        _spendAndInsert(ctx, inputs.nullifier, inputs.new_commitment);
        uint64 deltaSold = att.amountA - rec.sold_shares;
        rec.sold_shares = att.amountA;
        rec.sell_proceeds = att.amountB;
        fullClose = att.amountA == rec.expected_shares; // named return → caller releases the fee on full close
        rec.status = fullClose ? BetStatus.CLOSED_CREDITED : BetStatus.FILLED;

        emit BetSold(inputs.nullifier_of_bet, deltaSold, credit);
        emit PositionClosed(inputs.nullifier, inputs.nullifier_of_bet, inputs.new_commitment, fullClose);
    }

    /// @return protocolEarned the protocol fee on the EXECUTED part (the caller adds it to the
    /// claimable feeAccumulator). The unexecuted part is refunded to the user via the injected amount.
    function partialFillCredit(
        Ctx memory ctx,
        mapping(bytes32 => BetRecord) storage betRecords,
        mapping(bytes32 => uint64) storage betProtocolFee,
        address verifier,
        bytes calldata proof,
        PartialFillPublicInputs calldata inputs,
        OperatorAttestation calldata att,
        bytes calldata sig
    ) external returns (uint64 protocolEarned) {
        _requireUnspentKnownRoot(ctx, inputs.nullifier, inputs.merkle_root);

        BetRecord storage rec = betRecords[inputs.nullifier_of_bet];
        if (rec.market_id == bytes32(0)) revert BetNotFound();
        if (rec.status != BetStatus.ACTIVE) revert BetNotPartialFilled();
        _checkAttestation(ctx, att, sig, inputs.nullifier_of_bet, REPORT_PARTIAL, REPORT_PARTIAL);

        uint64 filled_shares = att.amountA;
        uint64 spent_amount = att.amountB;
        if (filled_shares == 0 || filled_shares >= rec.expected_shares) revert InvalidFilledShares();
        // L3 (B-relax): allow spent_amount == bet_amount with filled < expected. A round-number
        // market order can spend the full budget yet acquire fewer shares than committed (price
        // ticked up); that is a genuine short fill that MUST normalize expected_shares down, but
        // its refund is 0. The strict `<` would have reverted it, leaving settlement to over-credit
        // on the committed expected_shares. spent_amount can never exceed bet_amount (the on-chain
        // debit and the order's budget cap), so `>` is the correct upper bound.
        if (spent_amount == 0 || spent_amount > rec.bet_amount) revert InvalidSpentAmount();
        // FC-14: refund the unfilled stake PLUS the pro-rata protocol fee on the unexecuted portion
        // (relay-gas fee kept), and report the protocol fee on the EXECUTED part as earned (caller
        // adds it to claimable feeAccumulator). A fee-only short fill has unexecuted == 0 → refund 0,
        // earned = full protocolFee. Computed from the recorded fee BEFORE normalization; the
        // frontend/recovery mirror the refund floor math. A block scope keeps the legacy stack shallow.
        uint64 refund_amount;
        {
            uint64 pf = betProtocolFee[inputs.nullifier_of_bet];
            uint64 refundedPf = uint64((uint256(pf) * (rec.bet_amount - spent_amount)) / rec.bet_amount);
            refund_amount = (rec.bet_amount - spent_amount) + refundedPf;
            protocolEarned = pf - refundedPf;
        }

        if (!VaultInputs.verifyPartialCredit(verifier, proof, inputs, refund_amount)) revert InvalidProof();

        _spendAndInsert(ctx, inputs.nullifier, inputs.new_commitment);

        betProtocolFee[inputs.nullifier_of_bet] = 0; // resolved: refundable part returned, earned part released by caller
        rec.expected_shares = filled_shares;
        rec.bet_amount = spent_amount;
        rec.status = BetStatus.FILLED;
        rec.filled_shares = 0;
        rec.spent_amount = 0;

        emit PartialFillCredited(inputs.nullifier, inputs.nullifier_of_bet, inputs.new_commitment);
    }

    /// @notice FC-8: merge up to 4 same-owner notes into one. No betRecords / token movement,
    /// so it needs only the tree/nullifiers/verifier handles (no Ctx, no storage refs).
    function consolidate(
        CommitmentMerkleTree tree,
        NullifierRegistry nullifiers,
        address consolidateVerifier,
        bytes calldata proof,
        ConsolidatePublicInputs calldata inputs
    ) external {
        if (!tree.isKnownRoot(inputs.merkle_root)) revert UnknownRoot();
        if (inputs.nullifier[0] == bytes32(0)) revert EmptyConsolidation();

        for (uint256 j = 0; j < 4; j++) {
            if (inputs.nullifier[j] != bytes32(0) && nullifiers.isSpent(inputs.nullifier[j]))
                revert NullifierSpent();
        }
        if (!VaultInputs.verifyConsolidate(consolidateVerifier, proof, inputs)) revert InvalidProof();

        for (uint256 j = 0; j < 4; j++) {
            if (inputs.nullifier[j] != bytes32(0)) nullifiers.markSpent(inputs.nullifier[j]);
        }
        tree.insert(inputs.new_commitment);

        emit Consolidated(inputs.nullifier, inputs.new_commitment);
    }
}
