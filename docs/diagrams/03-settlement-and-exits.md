# 3 — Settlement, Credits & Exits

[← back to index](README.md)

How value is credited back into notes after a bet concludes, and how it finally leaves
the vault. Every flow here is a **note-spend**: the user spends their post-bet note,
proves membership, and recommits a new balance — routed through the Proof Relay so the
depositor never appears on-chain.

- [3.1 Settlement Phase 1 — redemption + `resolveMarket`](#31-settlement-phase-1--redemption--resolvemarket)
- [3.2 Settlement Phase 2 — credit claim](#32-settlement-phase-2--credit-claim)
- [3.3 Withdrawal (W-to-W)](#33-withdrawal-w-to-w)
- [3.4 Bet-cancellation credit (FOK failed)](#34-bet-cancellation-credit-fok-failed)
- [3.5 N/A-cancellation credit (market voided)](#35-na-cancellation-credit-market-voided)
- [3.6 Position close (FC-1)](#36-position-close-fc-1)
- [3.7 Partial-fill credit (FC-4)](#37-partial-fill-credit-fc-4)

**Bet record state machine** (the spine of this whole file):

```mermaid
stateDiagram-v2
    [*] --> ACTIVE: authorizeBet
    ACTIVE --> RESTING: GTC/GTD live (UI signal)
    ACTIVE --> FILLED: partialFillCredit (normalize)
    RESTING --> FILLED: partialFillCredit (normalize)
    ACTIVE --> CREDITED: creditSettlement (+FILLED att)
    FILLED --> CREDITED: creditSettlement
    ACTIVE --> CANCELLED_CREDITED: betCancel/naCancel (+att)
    FILLED --> CANCELLED_CREDITED: naCancellationCredit
    FAILED --> CANCELLED_CREDITED: betCancellationCredit
    ACTIVE --> FAILED: adminCancelBet
    ACTIVE --> CLOSED_CREDITED: closePosition (+SOLD att)
    FILLED --> CLOSED_CREDITED: closePosition (+SOLD att)
    CREDITED --> [*]
    CANCELLED_CREDITED --> [*]
    CLOSED_CREDITED --> [*]

    note right of FILLED
        On-chain FILLED is reached ONLY via
        partialFillCredit normalization.
        A plain full fill stays ACTIVE +
        a FILLED attestation.
    end note
```

---

## 3.1 Settlement Phase 1 — redemption + `resolveMarket`

Fully **operator/indexer-driven, no user action.** When a market resolves on-chain, the
Signing Layer records the payout (`resolveMarket`) **FIRST** so users can settle, **then**
best-effort redeems the Deposit Wallet's CTF shares, offramps the proceeds back to the
Vault, and acknowledges the returned capital. Detection is via a `tracked_markets` poll
(`payoutDenominator` state read) and/or a filtered `ctf.on` — see [§4.4](04-operator-resilience.md#44-settlement-resolver-poll--filtered-ctfon).

```mermaid
sequenceDiagram
    autonumber
    box rgb(254,226,226) Polymarket
        participant CTF as 🎰 CTF
        participant DW as 👛 Deposit Wallet
        participant OFF as 🔁 Offramp
    end
    box rgb(254,243,199) Indexer
        participant IX as 🗂️ Indexer
    end
    box rgb(255,237,213) Signing Layer
        participant SR as 📥 Settlement Resolver
        participant RP as ⚙️ Redemption Pipeline
        participant EX as 🚚 DW Executor
        participant FT as 📡 Fill Tracker
    end
    box rgb(187,247,208) On-chain
        participant V as 📜 Vault
    end

    CTF-->>SR: ConditionResolution(conditionId, numerators)
    CTF-->>IX: ConditionResolution  →  upsertSettlement(record)
    SR->>SR: waitForTransaction(1 conf)
    SR->>FT: cancelOrdersForMarket(conditionId)  → resting GTC/GTD → FAILED att
    alt all numerators zero (N/A)
        SR->>SR: skip redemption (users use naCancellationCredit)
    else resolved with payout
        SR->>RP: runRedemptionPipeline(conditionId)
        Note over RP,V: ① resolve FIRST (independent of redemption) so users can settle
        RP->>V: resolveMarket(conditionId)
        activate V
        V->>CTF: read payouts ELEMENT-by-index:<br/>getOutcomeSlotCount + payoutNumerators(cond, i)<br/>(NO array getter on mainnet CTF — FC-12)
        V->>V: pendingCredit[circuit_key][outcome] = num/den · marketResolvedAt[key]=now · conditionIdOf[key]=cond
        V-->>IX: emit MarketResolved(circuit_key, resolvedAt)  → setResolvedAt()
        deactivate V
        Note over RP,EX: ② THEN best-effort collateral redemption (failure here does NOT block settlement)
        RP->>V: scan BetAuthorized → position_ids for this condition
        RP->>CTF: balanceOf(DepositWallet, positionId) — holds winning shares?
        RP->>EX: redeem: ctf.redeemPositions(pUSD, 0, conditionId, indexSets)
        EX->>DW: WALLET batch (relayer/proxy)  → CTF burned, pUSD returned
        RP->>EX: offramp batch: approve → Offramp.withdraw → transfer USDC→Vault
        EX->>OFF: pUSD → USDC → Vault
        RP->>V: acknowledgePolymarketReturn(min(returned, deployed))
        Note over V: deployedToPolymarket -= ack
    end
```

After this, `GET /settlement/:market_id` returns `claimable: true`.

---

## 3.2 Settlement Phase 2 — credit claim

User-initiated, after Phase 1. The user spends their current cash note and recommits
`balance + total_credit`. The Vault **injects** `payout_per_share` (from `pendingCredit`)
and `shares_held` (from `betRecords`) and checks the arithmetic on-chain — the user
cannot inflate the credit.

```mermaid
sequenceDiagram
    autonumber
    box rgb(204,251,241) Frontend
        participant FE as 🖥️ Settlement Modal
        participant PV as 🔐 WASM Prover
    end
    box rgb(254,243,199) Indexer
        participant IX as 🗂️ Indexer
    end
    box rgb(255,237,213) Signing Layer
        participant AS as 🗄️ Attestation Store
    end
    box rgb(237,233,254) Relay
        participant RL as 📨 Proof Relay
    end
    box rgb(187,247,208) On-chain
        participant V as 📜 Vault
        participant SV as 🔐 SettlementVerifier #1
    end

    FE->>IX: GET /settlement/{market_id}
    IX-->>FE: {payout_per_share, outcome, claimable:true}
    FE->>AS: GET /attestation/{nullifier_of_bet}  (FILLED, if bet still ACTIVE)
    AS-->>FE: {reportType:FILLED, sig}
    FE->>RL: GET /merkle-path/{current_note}
    rect rgb(252,231,243)
        FE->>PV: settlement_credit proof{secret,bal,nonce,bet_nonce,path…, nullifier_of_bet, market, total_credit}
        PV-->>FE: proof
    end
    FE->>RL: POST /relay/settlement {proof, inputs, att, sig}
    RL->>RL: pre-flight checkBetFilled(nullifier_of_bet)
    RL->>V: creditSettlement(proof, inputs, att, sig)
    activate V
    V->>V: nullifier unspent? root known? rec found? market matches?
    alt status == FILLED
        Note over V: no attestation needed
    else status == ACTIVE
        V->>V: _checkAttestation(FILLED) → recover == operator
    end
    V->>V: marketResolvedAt[key] ≠ 0 ?
    V->>V: payout = pendingCredit[key][side] · require shares·payout == total_credit
    V->>SV: verifySettlement(proof, inputs)
    SV-->>V: ✔
    V->>V: markSpent · insert new_commitment · status = CREDITED
    V-->>RL: emit SettlementCredited
    deactivate V
    FE->>FE: mark notes spent · add SETTLE_CREDIT note
```

---

## 3.3 Withdrawal (W-to-W)

Value leaves the vault. **Withdraw-to-wallet only**, enforced cryptographically: the
circuit binds `recipient_hash = Poseidon2(owner_address, 0)`, and the Vault independently
recomputes it from the passed `recipientAddress`. No mixer path. A flat `withdrawalFee`
is skimmed by the Vault (no circuit change).

```mermaid
sequenceDiagram
    autonumber
    box rgb(204,251,241) Frontend
        participant FE as 🖥️ Withdraw Page
        participant PV as 🔐 WASM Prover
    end
    box rgb(237,233,254) Relay
        participant RL as 📨 Proof Relay
    end
    box rgb(187,247,208) On-chain
        participant V as 📜 Vault
        participant WV as 🔐 WithdrawalVerifier #2
        participant USDC as 💵 USDC
    end

    FE->>FE: selectNotesForAmount() — consolidate first if needed (§1.2)
    FE->>FE: recipient_hash = Poseidon2(owner_address, 0)
    FE->>RL: GET /merkle-path/{note}
    rect rgb(252,231,243)
        FE->>PV: withdrawal proof{secret,bal,nonce,path…, recipient_address(private), withdrawal_amount, recipient_hash, new_commitment}
        PV-->>FE: proof
    end
    FE->>RL: POST /relay/withdrawal {proof, inputs, recipientAddress}
    RL->>V: withdraw(proof, inputs, recipientAddress)
    activate V
    V->>V: nullifier unspent? root known?
    V->>V: withdrawal_amount ≥ minWithdrawal ?
    V->>WV: verifyWithdrawal(proof, inputs)
    WV-->>V: ✔
    V->>V: tree.hashTwo(recipientAddress,0) == recipient_hash ? (else BadRecipient)
    V->>V: solvency: usdc.balanceOf(Vault) ≥ withdrawal_amount ?
    V->>V: markSpent · insert change note · feeAccumulator += withdrawalFee
    V->>USDC: transfer(recipientAddress, withdrawal_amount − withdrawalFee)
    V-->>RL: emit Withdrawn
    deactivate V
```

> **Recipient binding (T9):** `recipientAddress` is a *private* circuit input; only its
> hash is public. An MEV bot rewriting the recipient in the relay tx invalidates the proof.

---

## 3.4 Bet-cancellation credit (FOK failed)

Full refund when an order never filled (`FAILED`). The Vault **injects `bet_amount`** from
`betRecords` so the user cannot inflate the refund.

```mermaid
sequenceDiagram
    autonumber
    box rgb(204,251,241) Frontend
        participant FE as 🖥️ Cancel/Refund Modal
        participant PV as 🔐 WASM Prover
    end
    box rgb(255,237,213) Signing Layer
        participant AS as 🗄️ Attestation Store
    end
    box rgb(237,233,254) Relay
        participant RL as 📨 Proof Relay
    end
    box rgb(187,247,208) On-chain
        participant V as 📜 Vault
        participant CV as 🔐 BetCancelVerifier #3
    end

    AS-->>FE: attestation FAILED (or rec already FAILED via adminCancelBet)
    FE->>RL: GET /merkle-path/{post-bet note}
    rect rgb(252,231,243)
        FE->>PV: bet_cancel proof{secret,bal,nonce(=receipt.nonce+1),path…, nullifier_of_bet}
        Note over PV: spends the immediate post-bet note so<br/>Poseidon2(secret, nonce−1) = nullifier_of_bet
        PV-->>FE: proof (bet_amount Vault-injected)
    end
    FE->>RL: POST /relay/bet-cancel {proof, inputs, att, sig}
    RL->>V: betCancellationCredit(proof, inputs, att, sig)
    activate V
    V->>V: rec found?
    alt status == FAILED
        Note over V: no attestation needed
    else status == ACTIVE
        V->>V: _checkAttestation(FAILED) → recover == operator
    end
    V->>CV: verifyBetCancel(proof, inputs, rec.bet_amount)
    CV-->>V: ✔ newBal = bal + bet_amount
    V->>V: markSpent · insert · status = CANCELLED_CREDITED
    V-->>RL: emit BetCancellationCredited
    deactivate V
```

---

## 3.5 N/A-cancellation credit (market voided)

When a market resolves N/A (all CTF `payoutNumerators` zero **with** a non-zero
denominator), the bet is refunded its `bet_amount`. The Vault checks the N/A condition
on-chain (denominator guard added by TASK-C2; status guard by TASK-C1).

```mermaid
sequenceDiagram
    autonumber
    box rgb(204,251,241) Frontend
        participant FE as 🖥️ Cancel Modal
        participant PV as 🔐 WASM Prover
    end
    box rgb(237,233,254) Relay
        participant RL as 📨 Proof Relay
    end
    box rgb(187,247,208) On-chain
        participant V as 📜 Vault
        participant NV as 🔐 CancelCreditVerifier #4
        participant CTF as 🎰 CTF
    end

    FE->>RL: GET /merkle-path/{post-bet note}
    rect rgb(252,231,243)
        FE->>PV: cancel_credit proof{… nullifier_of_bet, market_id}
        PV-->>FE: proof (bet_amount Vault-injected)
    end
    FE->>RL: POST /relay/na-cancel {proof, inputs, att, sig}
    RL->>V: naCancellationCredit(proof, inputs, att, sig)
    activate V
    V->>V: rec found? market matches?
    alt status FILLED or FAILED
        Note over V: terminal — no att needed
    else status ACTIVE
        V->>V: _checkAttestation(FILLED or FAILED)
    end
    V->>CTF: payoutDenominator(market) > 0 ?  (C2 — else ConditionNotResolved)
    V->>CTF: payoutNumerators all zero ?       (else NotNA)
    V->>NV: verifyNACancel(proof, inputs, rec.bet_amount)
    NV-->>V: ✔
    V->>V: markSpent · insert · status = CANCELLED_CREDITED
    V-->>RL: emit NACancellationCredited
    deactivate V
```

---

## 3.6 Position close (FC-1)

Sell a *filled* position back on Polymarket **before** the market resolves. Two phases:
(1) the operator runs a FOK SELL and signs a **SOLD** attestation; (2) the user credits the
proceeds into their note. All-or-nothing: the attested `sold_shares` must equal the whole
held position.

```mermaid
sequenceDiagram
    autonumber
    box rgb(204,251,241) Frontend
        participant FE as 🖥️ Close Position Modal
        participant PV as 🔐 WASM Prover
    end
    box rgb(255,237,213) Signing Layer
        participant SL as ✍️ Close Endpoint
        participant OB as 🧱 Order Builder
        participant AS as 🗄️ Attestation Store
    end
    box rgb(254,226,226) Polymarket
        participant CLOB as 📈 CLOB
    end
    box rgb(237,233,254) Relay
        participant RL as 📨 Proof Relay
    end
    box rgb(187,247,208) On-chain
        participant V as 📜 Vault
        participant PCV as 🔐 PositionCloseVerifier #6
    end

    rect rgb(255,237,213)
        Note over FE,CLOB: Phase 1 — operator sells the position
        FE->>SL: POST /close-request {nullifier_of_bet, position_id, sold_shares, limit}
        SL->>OB: submitFOKSellOrder
        OB->>CLOB: FOK SELL
        CLOB-->>OB: filled @ proceeds
        OB->>AS: attest(SOLD, sold_shares, proceeds)
    end
    rect rgb(204,251,241)
        Note over FE,V: Phase 2 — user credits proceeds
        FE->>AS: poll GET /attestation/{nullifier}?reportType=4 until present
        AS-->>FE: {SOLD, amountA=sold_shares, amountB=proceeds, sig}
        FE->>RL: GET /merkle-path/{note}
        FE->>PV: position_close proof{… nullifier_of_bet, sell_proceeds}
        PV-->>FE: proof (sell_proceeds Vault-injected)
        FE->>RL: POST /relay/close {proof, inputs, att, sig}
        RL->>V: closePosition(proof, inputs, att, sig)
        activate V
        V->>V: status ACTIVE or FILLED? _checkAttestation(SOLD)?
        V->>V: att.amountA == expected_shares ? (full close)
        V->>V: market NOT resolved ? (resolved markets settle, not close)
        V->>PCV: verifyClose(proof, inputs, sell_proceeds)
        PCV-->>V: ✔ newBal = bal + proceeds
        V->>V: markSpent · insert · status = CLOSED_CREDITED
        V-->>RL: emit BetSold + PositionClosed
        deactivate V
    end
```

---

## 3.7 Partial-fill credit (FC-4)

When a limit order (FAK/GTC/GTD) **partially** fills then terminates, the unfilled
remainder is refunded and the record is **normalized to a clean `FILLED`**
(`expected_shares := filled_shares`, `bet_amount := spent_amount`). This is the *only*
path that reaches on-chain `FILLED` — which is what makes the no-attestation FILLED branch
of settlement/close/N/A safe. Constraint-identical circuit to `bet_cancel`.

```mermaid
sequenceDiagram
    autonumber
    box rgb(204,251,241) Frontend
        participant FE as 🖥️ Partial-Fill Modal
        participant PV as 🔐 WASM Prover
    end
    box rgb(255,237,213) Signing Layer
        participant AS as 🗄️ Attestation Store
    end
    box rgb(237,233,254) Relay
        participant RL as 📨 Proof Relay
    end
    box rgb(187,247,208) On-chain
        participant V as 📜 Vault
        participant PV7 as 🔐 PartialCreditVerifier #7
    end

    AS-->>FE: attestation PARTIAL{amountA=filled_shares, amountB=spent_amount}
    FE->>RL: GET /merkle-path/{post-bet note}
    rect rgb(252,231,243)
        FE->>PV: partial_credit proof{… nullifier_of_bet}
        PV-->>FE: proof (refund_amount Vault-injected = bet_amount − spent_amount)
    end
    FE->>RL: POST /relay/partial-credit {proof, inputs, att, sig}
    RL->>V: partialFillCredit(proof, inputs, att, sig)
    activate V
    V->>V: status == ACTIVE ? (not yet credited)
    V->>V: _checkAttestation(PARTIAL)
    V->>V: 0 < filled < expected ? · 0 < spent < bet_amount ? (strict partial)
    V->>V: refund_amount = bet_amount − spent_amount
    V->>PV7: verifyPartialCredit(proof, inputs, refund_amount)
    PV7-->>V: ✔ newBal = bal + refund_amount
    V->>V: markSpent · insert
    V->>V: NORMALIZE: expected_shares=filled · bet_amount=spent · status=FILLED
    V-->>RL: emit PartialFillCredited
    deactivate V
    Note over FE,V: position is now a normal FILLED record → settle/close/N/A later
```
