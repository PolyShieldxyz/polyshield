# 5 — Admin & Governance

[← back to index](README.md)

The owner-gated levers. The owner role is the **single largest trust assumption** in the
system (threat **T21**): UUPS upgrades are *instant, no timelock*, so the owner can replace
any contract's logic in one transaction. In production the owner role **MUST** be a
multisig/HSM, never a hot EOA.

- [5.1 UUPS owner upgrade (all proxies)](#51-uups-owner-upgrade-all-proxies)
- [5.2 Verifier swap (timelocked slot vs instant `setBase`)](#52-verifier-swap)
- [5.3 Fee-parameter update (`setFeeParams`)](#53-fee-parameter-update-setfeeparams)
- [5.4 Fee withdrawal / retraction (`withdrawFees`)](#54-fee-withdrawal--retraction-withdrawfees)
- [5.5 Admin-cancel bet (`adminCancelBet`)](#55-admin-cancel-bet-admincancelbet)
- [5.6 Operational levers (cap · pause · ack)](#56-operational-levers-cap--pause--ack)

**Owner authority map** (who can do what, and how fast):

```mermaid
flowchart TD
    O[🛡️ Owner multisig/HSM]:::admin
    OP[✍️ Signing Layer Operator]:::signer
    FR[💰 Fee Recipient]:::admin

    O -->|instant| UP["UUPS upgradeToAndCall — ANY proxy<br/>⚠️ total control, T21"]:::danger
    O -->|instant| SB["verifier setBase(newVK)"]:::danger
    O -->|"timelock 15m test / 48h prod"| VS["proposeVerifier → acceptVerifier"]:::admin
    O -->|instant| FP["setFeeParams"]:::admin
    O -->|instant| PA["pause / unpause"]:::admin
    O -->|instant| DC["setDeploymentCap (SEC-007)"]:::admin
    O -->|instant| SO["setSigningLayerOperator"]:::admin
    O -->|"timelock ≥3d (7d default)"| AC["adminCancelBet"]:::admin
    O -->|"min 3 days"| TL["setAdminCancelTimelock"]:::admin

    OP -->|onlyOperator| FW["fundPolymarketWallet"]:::signer
    OP -->|onlyOperator| RM["resolveMarket"]:::signer
    OP -->|onlyOperator| AK["acknowledgePolymarketReturn"]:::signer
    FR -->|onlyRecipient| WF["withdrawFees"]:::admin

    classDef admin fill:#e2e8f0,stroke:#475569,color:#0f172a
    classDef signer fill:#ffedd5,stroke:#ea580c,color:#431407
    classDef danger fill:#fee2e2,stroke:#dc2626,color:#450a0a
```

---

## 5.1 UUPS owner upgrade (all proxies)

Every production contract — `Vault`, `CommitmentMerkleTree`, `NullifierRegistry`,
`PoseidonT3Hasher`, and all 9 verifier adapters — is an implementation behind an
`ERC1967Proxy`. The **proxy address is permanent**; the logic behind it is swappable.

```mermaid
sequenceDiagram
    autonumber
    box rgb(226,232,240) Governance
        participant O as 🛡️ Owner multisig
        participant DEP as 🚀 Deployer
    end
    box rgb(187,247,208) On-chain
        participant IMPL as 🆕 New Implementation
        participant PXY as 🪞 ERC1967 Proxy (permanent addr)
        participant AUTH as 🔑 _authorizeUpgrade
    end

    DEP->>IMPL: deploy new logic (constructor calls _disableInitializers())
    Note over IMPL: storage append-only: shrink __gap, never reorder
    O->>PXY: upgradeToAndCall(newImpl, initData?)
    activate PXY
    PXY->>AUTH: _authorizeUpgrade(newImpl)
    AUTH->>AUTH: onlyOwner ✔ (INSTANT — no timelock)
    PXY->>PXY: ERC1967 implementation slot := newImpl
    opt one-time reinit (e.g. initializeV2)
        PXY->>IMPL: delegatecall initData (reinitializer guard)
    end
    PXY-->>O: Upgraded(newImpl)
    deactivate PXY

    Note over O,AUTH: ⚠️ T21: a malicious owner could ship logic that drains USDC,<br/>leaks depositor↔bet linkage, or disables nullifier checks — in ONE tx.<br/>Only mitigation today: multisig/HSM owner.
```

**Verifier adapter second lever — `setBase`:** each adapter exposes an owner-only
`setBase(address)` that adopts a new verification key *without* a proxy migration. This is
**instant** and orthogonal to the timelocked slot swap in §5.2.

---

## 5.2 Verifier swap

Two independent ways to change which verifier a proof type uses:

```mermaid
sequenceDiagram
    autonumber
    box rgb(226,232,240) Governance
        participant O as 🛡️ Owner
    end
    box rgb(187,247,208) On-chain
        participant V as 📜 Vault
        participant AD as 🔐 Verifier Adapter
    end

    rect rgb(226,232,240)
        Note over O,V: Lever A — Vault slot swap (TIMELOCKED, public notice)
        O->>V: proposeVerifier(proofType, newAddr)
        V-->>O: emit VerifierProposed(type, addr, availableAt = now + TIMELOCK)
        Note over V: VERIFIER_TIMELOCK = 15min (TEST) / 48h (PROD)
        O->>V: acceptVerifier(proofType)   ⟵ after timelock
        V->>V: pendingVerifiers[type] ≠ 0 ? (SEC-006) · now ≥ availableAt ?
        V->>V: verifiers[type] := pendingVerifiers[type]
        V-->>O: emit VerifierAccepted(type, addr)
    end

    rect rgb(254,226,226)
        Note over O,AD: Lever B — adapter setBase (INSTANT, no notice)
        O->>AD: setBase(newVKbase)
        AD->>AD: base := newVKbase   (same proxy, new VK)
    end
```

> The timelock on Lever A is the **public-notice window** that lets users/watchers detect a
> malicious or mistaken verifier swap before it goes live. Lever B has no such window —
> it is the faster, riskier path.

---

## 5.3 Fee-parameter update (`setFeeParams`)

All rates live in one packed `FeeConfig` struct, set atomically. The bet fee feeds the
**circuit** (Vault injects it into `bet_auth`); the withdrawal fee is Vault-only.

```mermaid
sequenceDiagram
    autonumber
    box rgb(226,232,240) Governance
        participant O as 🛡️ Owner
    end
    box rgb(187,247,208) On-chain
        participant V as 📜 Vault
    end

    O->>V: setFeeParams({betFeeBps, relayGasFeeUSDC, minBet, withdrawalFeeUSDC, minWithdrawal, feeRecipient})
    activate V
    V->>V: feeRecipient ≠ 0 ? (else ZeroAddress)
    V->>V: minWithdrawal ≥ withdrawalFeeUSDC ? (else InvalidAmount — withdraw underflow guard)
    V->>V: feeConfig := new config
    V-->>O: emit FeeParamsUpdated(config)
    deactivate V
    Note over V: next authorizeBet injects fee = bet·betFeeBps/1e4 + relayGas<br/>next withdraw skims withdrawalFeeUSDC — no circuit redeploy needed
```

---

## 5.4 Fee withdrawal / retraction (`withdrawFees`)

Accrued fees sit as USDC *in the pool* (`feeAccumulator`). Only `feeRecipient` may claim
them. This is the "fee retraction" path.

```mermaid
sequenceDiagram
    autonumber
    box rgb(226,232,240) Governance
        participant FR as 💰 Fee Recipient
    end
    box rgb(187,247,208) On-chain
        participant V as 📜 Vault
        participant USDC as 💵 USDC
    end

    Note over V: feeAccumulator grows on every bet (+fee) and withdrawal (+withdrawalFee)
    FR->>V: withdrawFees(amount)
    activate V
    V->>V: msg.sender == feeConfig.feeRecipient ? (else NotFeeRecipient)
    V->>V: amount ≤ feeAccumulator ? (else InvalidAmount)
    V->>V: feeAccumulator -= amount  (nonReentrant)
    V->>USDC: transfer(feeRecipient, amount)
    V-->>FR: emit FeesWithdrawn(to, amount)
    deactivate V
```

---

## 5.5 Admin-cancel bet (`adminCancelBet`)

Emergency escape hatch for a **permanently-gone** operator (lost keys / fully
unresponsive). Flips an `ACTIVE` bet to `FAILED` so the user can reclaim funds via
`betCancellationCredit`. Long timelock because under FC-9 an `ACTIVE` bet may actually be a
healthy filled-but-unclaimed position.

```mermaid
sequenceDiagram
    autonumber
    box rgb(226,232,240) Governance
        participant O as 🛡️ Owner
    end
    box rgb(187,247,208) On-chain
        participant V as 📜 Vault
    end
    box rgb(204,251,241) User later
        participant U as 🖥️ Frontend
    end

    Note over O: owner first confirms OFF-CHAIN that no fill / no attestation occurred
    O->>V: adminCancelBet(nullifier_of_bet)
    activate V
    V->>V: rec found? (else BetNotFound)
    V->>V: status == ACTIVE ? (else BetNotActive — RESTING/FILLED exempt)
    V->>V: now ≥ betCreatedAt + adminCancelTimelock ? (else BetTimeoutNotElapsed)
    Note over V: adminCancelTimelock floor 3 days, 7-day default (initializeV2)
    V->>V: status := FAILED
    V-->>O: emit AdminBetCancelled
    deactivate V
    U->>V: betCancellationCredit(...) → recover bet_amount (§3.4)
```

---

## 5.6 Operational levers (cap · pause · ack)

Smaller owner/operator levers grouped together.

```mermaid
flowchart LR
    subgraph OWNER["🛡️ Owner"]
        P1["pause()"]:::admin
        P2["unpause()"]:::admin
        DC["setDeploymentCap(cap)<br/>SEC-007 aggregate ceiling"]:::admin
        SO["setSigningLayerOperator(addr)"]:::admin
        TL["setAdminCancelTimelock(≥3d)"]:::admin
    end
    subgraph OPER["✍️ Operator"]
        FW["fundPolymarketWallet — whenNotPaused, ≤ cap"]:::signer
        AK["acknowledgePolymarketReturn — deployed -= amt"]:::signer
        RM["resolveMarket — store pendingCredit"]:::signer
    end
    subgraph EFFECT["Effect on user flows"]
        PE["deposit · authorizeBet · credit · withdraw<br/>all whenNotPaused ⟹ blocked while paused"]:::contract
        CE["fundPolymarketWallet bounded ⟹ bounds<br/>compromised-operator blast radius (T6)"]:::contract
    end

    P1 --> PE
    DC --> CE
    FW --> CE
    P1 -. "blocks" .-> FW

    classDef admin fill:#e2e8f0,stroke:#475569,color:#0f172a
    classDef signer fill:#ffedd5,stroke:#ea580c,color:#431407
    classDef contract fill:#bbf7d0,stroke:#16a34a,color:#052e16
```
