# 6 — Adversarial & Direct-Access Paths

[← back to index](README.md)

The contract layer is **permissionless** — anyone can call any non-admin Vault function
from any address. This file diagrams what happens when a curious or malicious actor
*skips the frontend/relay* and pokes the contracts directly. The recurring theme:

> **The contract enforces every *soundness* and *value* check, so funds and balances are
> safe. The one thing it cannot enforce is *privacy* — that is a client discipline.**

Cross-reference: [`docs/threat-model.md`](../threat-model.md).

- [6.1 T19 — direct `authorizeBet` self-deanonymization (the one that bites)](#61-t19--direct-authorizebet-self-deanonymization)
- [6.2 T20 — deposit-balance forgery (blocked)](#62-t20--deposit-balance-forgery-blocked)
- [6.3 T7 — nullifier double-spend (blocked)](#63-t7--nullifier-double-spend-blocked)
- [6.4 Fee under-payment forgery (blocked)](#64-fee-under-payment-forgery-blocked)
- [6.5 Operator-attestation forgery (blocked)](#65-operator-attestation-forgery-blocked)
- [6.6 Double-credit & credit inflation (blocked)](#66-double-credit--credit-inflation-blocked)
- [6.7 Withdrawal recipient redirection (blocked)](#67-withdrawal-recipient-redirection-blocked)

**Map of attacker entry points vs. what catches them:**

```mermaid
flowchart TB
    A([😈 Attacker / curious user]):::danger

    A -->|"calls Vault directly from own wallet"| T19
    A -->|"deposit with balance ≠ amount"| T20
    A -->|"replay spent note"| T7
    A -->|"proof with smaller fee"| FEE
    A -->|"self-signed attestation"| ATT
    A -->|"credit twice / inflate"| DC
    A -->|"rewrite withdraw recipient"| RCP

    T19["🟥 PRIVACY LOSS (not fund loss)<br/>msg.sender linked to bet on-chain"]:::danger
    T20["🛡️ DepositVerifier #5: commitment must =<br/>Poseidon4(secret, amount, 0, msg.sender)"]:::contract
    T7["🛡️ NullifierRegistry.markSpent →<br/>AlreadySpent on replay"]:::contract
    FEE["🛡️ Vault injects fee → new_commitment<br/>mismatch → verify fails"]:::contract
    ATT["🛡️ ECDSA.recover ≠ operator →<br/>InvalidAttestation"]:::contract
    DC["🛡️ terminal BetStatus + on-chain<br/>total_credit arithmetic check"]:::contract
    RCP["🛡️ recipient_hash bound in circuit +<br/>re-checked on-chain → BadRecipient"]:::contract

    classDef danger fill:#fee2e2,stroke:#dc2626,color:#450a0a
    classDef contract fill:#bbf7d0,stroke:#16a34a,color:#052e16
```

---

## 6.1 T19 — direct `authorizeBet` self-deanonymization

**Severity: CRITICAL (privacy).** This is the *only* direct-path attack that actually
succeeds — and it harms only the attacker themselves. `authorizeBet` deliberately does
**not** check `msg.sender` (it must be relayable by anyone), so if a user wires the bet
button to their own wallet, their address becomes `tx.from` and is permanently linked to
the bet on-chain. The proof is still valid; the *privacy invariant* is what breaks.

```mermaid
sequenceDiagram
    autonumber
    box rgb(219,234,254) User
        participant W as 👤 Wallet
    end
    box rgb(187,247,208) On-chain
        participant V as 📜 Vault
    end
    box rgb(254,226,226) Observer
        participant OBS as 🔍 Chain analyst
    end

    rect rgb(254,226,226)
        Note over W,V: ❌ WRONG — direct from wallet
        W->>V: authorizeBet(proof, inputs)   tx.from = USER ADDRESS
        V-->>W: emit BetAuthorized (valid!)
        OBS->>OBS: link depositor address ↔ this bet  → privacy broken
    end
    rect rgb(204,251,241)
        Note over W,V: ✅ CORRECT — via relay (see §2)
        Note over W: frontend POSTs proof to Proof Relay over HTTP (ideally Tor)
        V-->>V: relay calls authorizeBet, tx.from = RELAY
        OBS->>OBS: sees only the relay address — no depositor link
    end
```

**Why the contract can't fix this:** requiring `msg.sender == relay` would centralize
submission and break censorship-resistance. The defense is architectural: the frontend
has *no* code path to submit any spend tx except via the relay; only `deposit()` is signed
by the user's wallet. Enforced by CLAUDE.md + a frontend test asserting no
wallet-connected `writeContract` ever targets `authorizeBet`/`creditSettlement`.

---

## 6.2 T20 — deposit-balance forgery (blocked)

**Attempt:** deposit 100 USDC but commit a note that opens to 200, then later withdraw 200
and steal 100 from the pool.

```mermaid
flowchart TD
    A([😈 deposit forged note]):::danger
    C["commitment = Poseidon4(secret, 200e6, 0, owner)"]:::danger
    CALL["Vault.deposit(proof, commitment, amount=100e6)"]:::contract
    VER["DepositVerifier #5 public inputs:<br/>(commitment, amount=100e6, msg.sender)"]:::contract
    CHK{"proof constraint:<br/>commitment == Poseidon4(secret, AMOUNT, 0, msg.sender)<br/>i.e. balance MUST equal amount"}:::contract
    REV[revert InvalidProof — 200 ≠ 100]:::danger
    OK[deposit only succeeds when balance == amount == 100e6]:::contract

    A --> C --> CALL --> VER --> CHK
    CHK -- "forged (200≠100)" --> REV
    CHK -- "honest (100==100)" --> OK

    classDef danger fill:#fee2e2,stroke:#dc2626,color:#450a0a
    classDef contract fill:#bbf7d0,stroke:#16a34a,color:#052e16
```

The mandatory FC-2 proof binds `balance == amount`, `nonce == 0`, `owner == msg.sender`.
There is no proofless `deposit` entry point.

---

## 6.3 T7 — nullifier double-spend (blocked)

**Attempt:** spend the same note twice (e.g. two withdrawals) for double the funds.

```mermaid
sequenceDiagram
    autonumber
    box rgb(254,226,226) Attacker
        participant A as 😈 via relay
    end
    box rgb(187,247,208) On-chain
        participant V as 📜 Vault
        participant N as 🚫 NullifierRegistry
    end

    A->>V: withdraw(proof, inputs)  [nullifier X]
    V->>N: isSpent(X)? → false
    V->>V: verify ✔
    V->>N: markSpent(X)  → X now spent
    V-->>A: payout #1 ✔
    A->>V: withdraw(same proof / same note)  [nullifier X again]
    V->>N: isSpent(X)? → TRUE
    V-->>A: revert NullifierSpent ❌
    Note over V,N: nullifier check is the FIRST op (checks-effects-interactions);<br/>consolidate deliberately skips de-dup so duplicate slots also revert here
```

---

## 6.4 Fee under-payment forgery (blocked)

**Attempt:** craft a `bet_auth` proof that deducts a smaller fee than governance requires,
keeping more balance.

```mermaid
flowchart TD
    A([😈 proof built with fee = 0]):::danger
    SUB["authorizeBet(proof, inputs)"]:::contract
    INJ["Vault computes authoritative fee =<br/>bet_amount·betFeeBps/1e4 + relayGasFeeUSDC"]:::contract
    PASS["verifyBetAuth(proof, inputs, fee) — fee is a PUBLIC input"]:::contract
    CHK{"circuit: new_commitment opens to<br/>bal − bet − fee, using the INJECTED fee"}:::contract
    REV["revert InvalidProof<br/>(attacker's new_commitment used fee=0)"]:::danger
    OK[passes only when proof used the real fee]:::contract

    A --> SUB --> INJ --> PASS --> CHK
    CHK -- "fee mismatch" --> REV
    CHK -- "fee matches" --> OK

    classDef danger fill:#fee2e2,stroke:#dc2626,color:#450a0a
    classDef contract fill:#bbf7d0,stroke:#16a34a,color:#052e16
```

Same anti-forgery pattern as Vault-injected `bet_amount` / `refund_amount` /
`sell_proceeds`: the user doesn't get to choose the value the circuit commits to.

---

## 6.5 Operator-attestation forgery (blocked)

**Attempt:** self-sign an `OperatorAttestation` (e.g. fake a SOLD with huge proceeds, or a
FILLED on a never-placed order) to credit value that was never earned.

```mermaid
sequenceDiagram
    autonumber
    box rgb(254,226,226) Attacker
        participant A as 😈
    end
    box rgb(187,247,208) On-chain
        participant V as 📜 Vault
    end

    A->>A: sign attestation with ATTACKER key (not operator)
    A->>V: closePosition(proof, inputs, att, sig)
    V->>V: _verifyOperatorAttestation: ECDSA.recover(_hashTypedDataV4(att), sig)
    V->>V: recovered == signingLayerOperator ?
    V-->>A: revert InvalidAttestation ❌
    Note over V: also AttestationMismatch if att.nullifierOfBet / reportType ≠ the call's
    Note over A,V: EIP-712 domain {Polyshield, v1, chainId, Vault} prevents cross-domain replay.<br/>Even a REAL operator sig is one-shot: terminal BetStatus + single-use note block reuse (T22).
```

---

## 6.6 Double-credit & credit inflation (blocked)

**Attempt A — credit the same bet twice.** **Attempt B — claim more than earned.**

```mermaid
flowchart TD
    subgraph A2["Attempt A — double credit"]
        direction TB
        A1["creditSettlement on bet B"]:::contract
        S1["status → CREDITED (terminal)"]:::contract
        A2x["creditSettlement on bet B again"]:::danger
        R1["revert BetNotFilled / re-spend blocked<br/>(post-bet note nullifier already spent)"]:::danger
        A1 --> S1 --> A2x --> R1
    end
    subgraph B2["Attempt B — inflate credit"]
        direction TB
        B1["proof claims total_credit = 1e12"]:::danger
        B2x["Vault: shares_held = betRecords.expected_shares<br/>payout = pendingCredit[key][side]"]:::contract
        B3{"require shares·payout == total_credit"}:::contract
        B4[revert 'Invalid total_credit']:::danger
        B1 --> B2x --> B3 -- mismatch --> B4
    end

    classDef contract fill:#bbf7d0,stroke:#16a34a,color:#052e16
    classDef danger fill:#fee2e2,stroke:#dc2626,color:#450a0a
```

Cross-function double-credit (e.g. `partialFillCredit` then `naCancellationCredit`) is
blocked by the **shared terminal statuses** (`CREDITED` / `CANCELLED_CREDITED` /
`CLOSED_CREDITED`) plus the single-use post-bet note.

---

## 6.7 Withdrawal recipient redirection (blocked)

**Attempt:** an MEV bot (or malicious relay) rewrites `recipientAddress` in the withdraw
tx to steal the payout. This is also why withdrawals are W-to-W only.

```mermaid
sequenceDiagram
    autonumber
    box rgb(254,226,226) MEV bot / relay
        participant M as 😈
    end
    box rgb(187,247,208) On-chain
        participant V as 📜 Vault
    end

    Note over M: proof's recipient_hash = Poseidon2(owner_address, 0) — PRIVATE recipient
    M->>V: withdraw(proof, inputs, recipientAddress = ATTACKER)
    V->>V: verifyWithdrawal ✔ (proof itself is valid)
    V->>V: tree.hashTwo(ATTACKER, 0) == recipient_hash ?
    V-->>M: revert BadRecipient ❌  (attacker hash ≠ owner hash)
    Note over V: only the address whose hash is baked into the proof can receive →<br/>enforces withdraw-to-self, defeats T9 front-running
```

---

## 6.8 Malicious backend index / recovery-data (T24 — bounded)

**Attempt:** a compromised proof-relay index tries to de-anonymize users or fabricate notes via `/recovery-data` and `/merkle-path`.

```mermaid
flowchart TD
    BAD[😈 malicious / buggy backend index]:::poly
    A1{de-anonymize:<br/>link a spend to a wallet?}:::poly
    A2{forge a note into<br/>a user's recovery?}:::poly
    A3{forge a merkle path<br/>to mint funds?}:::poly
    A4[omit real events]:::poly

    R1["❌ CAN'T — stores only PUBLIC data; only Deposited is<br/>wallet-keyed (public by design). No secret server-side ⟹<br/>spends can't be linked to a wallet"]:::contract
    R2["❌ CAN'T — client replay keeps only events whose nullifier ==<br/>its OWN derived Poseidon2(secret,nonce); a forged event<br/>matches no secret the backend has ⟹ ignored"]:::contract
    R3["❌ CAN'T — on-chain verifier checks proof.merkle_root ∈ knownRoots;<br/>a path not reproducing a known root is rejected"]:::contract
    R4["⚠️ CAN — worst case = INCOMPLETE recovery (some notes not rebuilt).<br/>Availability, not safety. On-chain tree stays authoritative;<br/>frontend keeps a direct-chain fallback. Hardening: client<br/>checks served currentRoot vs on-chain (open)"]:::admin

    BAD --> A1 --> R1
    BAD --> A2 --> R2
    BAD --> A3 --> R3
    BAD --> A4 --> R4

    classDef poly fill:#fee2e2,stroke:#dc2626,color:#450a0a
    classDef contract fill:#bbf7d0,stroke:#16a34a,color:#052e16
    classDef admin fill:#e2e8f0,stroke:#475569,color:#0f172a
```

> The index/cache is a **liveness** dependency, not a safety one. See [`threat-model.md` T24](../threat-model.md) and [§4.3](04-operator-resilience.md#43-backend-indexcache--note-recovery-fc-12).

---

## Summary — what the direct path can and cannot do

| Attack | Direct-path outcome | Guard |
|---|---|---|
| Bet from own wallet (T19) | ⚠️ **Succeeds — self-deanonymizes** | Architectural only (relay-only frontend) |
| Forge deposit balance (T20) | 🛡️ Blocked | DepositVerifier binds `balance==amount==`paid |
| Double-spend note (T7) | 🛡️ Blocked | NullifierRegistry, checks-first |
| Under-pay fee | 🛡️ Blocked | Vault-injected `fee` public input |
| Forge attestation | 🛡️ Blocked | `ECDSA.recover == operator`, EIP-712 domain |
| Double / inflate credit | 🛡️ Blocked | Terminal status + on-chain arithmetic |
| Redirect withdrawal | 🛡️ Blocked | `recipient_hash` bound + re-checked |
| Stale Merkle root | 🛡️ Blocked | 1024-root O(1) window (FC-3) |
| Backend de-anon / forge note (T24) | 🛡️ Blocked | Public-only data; client matches own nullifier; root-checked path |
| Backend omits events (T24) | ⚠️ Incomplete recovery only | Liveness not safety; direct-chain fallback |

**The single takeaway:** the contracts protect *money*; only the client protects
*privacy*. Every "blocked" row is enforced on-chain regardless of entry path — the one
red row (T19) is the user's own responsibility, and the backend index can only ever
withhold data, never steal or de-anonymize.
