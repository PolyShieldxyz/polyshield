# 4 — Operator Resilience & Infrastructure

[← back to index](README.md)

The plumbing that lets the Signing Layer act on the Polymarket Deposit Wallet, and the
safety machinery that halts it when Polymarket bans the account.

- [4.1 Deposit-wallet executor (mock vs mainnet)](#41-deposit-wallet-executor-mock-vs-mainnet)
- [4.2 Heartbeat + dead-man circuit breaker](#42-heartbeat--dead-man-circuit-breaker)
- [4.3 Backend index/cache + note recovery (FC-12)](#43-backend-indexcache--note-recovery-fc-12)
- [4.4 Settlement resolver (poll + filtered ctf.on)](#44-settlement-resolver-poll--filtered-ctfon)
- [4.5 RPC resilience & requirements](#45-rpc-resilience--requirements)

---

## 4.1 Deposit-wallet executor (mock vs mainnet)

Every action *on the Deposit Wallet* (funding downstream, redemption, offramp, ERC-20 /
ERC-1155 approvals) is a **relayer → proxy batch**, abstracted behind
`DepositWalletExecutor` so the same call sites serve local dev and mainnet. The concrete
executor is chosen at startup from env.

```mermaid
flowchart TD
    CALL["redemption / offramp / approvals<br/>(redemptionPipeline.ts)"]:::signer
    GET["getDepositWalletExecutor(provider)"]:::signer
    SEL{config?}:::signer

    subgraph MOCK["🧪 Local dev"]
        MR[MockRelayerExecutor]:::signer
        MRH["POST /relayer/wallet-batch<br/>{calls:[{target,value,data}]}"]:::signer
        MDW[👛 MockDepositWallet proxy]:::poly
        MR --> MRH --> MDW
    end

    subgraph PROD["🛰️ Mainnet"]
        PR[PolymarketRelayerExecutor]:::signer
        RC["RelayClient.executeDepositWalletBatch()<br/>EIP-712 WALLET batch signed by operator EOA"]:::signer
        BREL[🛰️ Builder Relayer]:::poly
        PDW[👛 Polymarket Deposit Wallet proxy]:::poly
        PR --> RC --> BREL --> PDW
    end

    subgraph LEGACY["EOA fallback"]
        EE[EoaExecutor — sequential txs from DEPOSIT_WALLET_KEY]:::signer
    end

    CALL --> GET --> SEL
    SEL -- MOCK_RELAYER_URL --> MR
    SEL -- POLY_RELAYER_URL --> PR
    SEL -- DEPOSIT_WALLET_KEY --> EE
    SEL -- none --> UNC[UnconfiguredExecutor — throws]:::danger

    classDef signer fill:#ffedd5,stroke:#ea580c,color:#431407
    classDef poly fill:#fee2e2,stroke:#dc2626,color:#450a0a
    classDef danger fill:#fee2e2,stroke:#dc2626,color:#450a0a
```

**One-time approval bootstrap** (`ensureApprovals`, run at startup):

```mermaid
sequenceDiagram
    autonumber
    box rgb(255,237,213) Signing Layer
        participant IDX as 🚀 index.ts boot
        participant EX as 🚚 Executor
    end
    box rgb(254,226,226) Polymarket
        participant REL as 🛰️ Relayer
        participant DW as 👛 Deposit Wallet
        participant CTF as 🎰 CTF
    end

    IDX->>EX: ensureApprovals()
    EX->>REL: getDeployed(DepositWallet)?
    alt not yet deployed
        EX->>REL: deployDepositWallet()  (WALLET-CREATE)
        REL->>DW: create proxy
    end
    EX->>REL: WALLET batch:
    Note over EX,DW: • approve pUSD → CTF exchange<br/>• approve pUSD → Offramp<br/>• setApprovalForAll CTF → CTF Exchange v2
    REL->>DW: execute batch
```

---

## 4.2 Heartbeat + dead-man circuit breaker

A ban (`HTTP 403` or `ACCOUNT_FLAGGED`) must halt **all** signing instantly. Two
contract-level levers complement the off-chain breaker: the owner can `pause()` the Vault,
and `adminCancelBet` ([§5.5](05-admin-governance.md#55-admin-cancel-bet-admincancelbet))
is the last resort for a permanently-gone operator.

```mermaid
sequenceDiagram
    autonumber
    box rgb(255,237,213) Signing Layer
        participant HB as 💓 Heartbeat (5s)
        participant CB as 🛑 Circuit Breaker
        participant OB as 🧱 Order Builder
        participant FT as 📡 Fill Tracker
        participant PROC as ⚙️ Process
    end
    box rgb(254,226,226) Polymarket
        participant CLOB as 📈 CLOB
    end

    loop every 5 seconds
        HB->>CLOB: postHeartbeat()
        CLOB-->>HB: status / body
        HB->>CB: checkResponse(status, body)
        alt 403 OR ACCOUNT_FLAGGED / ACCOUNT_BANNED
            CB->>HB: stopHeartbeat()
            CB->>PROC: halt() → process.exit(1)  (operator paged)
            Note over OB,FT: every submit guarded by isHalted() ⟹ all new orders skipped
        else healthy
            CB-->>HB: continue
        end
    end
```

**Full ban-recovery picture (off-chain breaker → on-chain safety net):**

```mermaid
flowchart LR
    BAN([Polymarket bans vault EOA]):::poly
    DET[Heartbeat detects 403 / FLAGGED]:::signer
    HALT[Circuit breaker halts signing<br/>process exits, alert fires]:::signer
    SAFE["Funds are SAFE:<br/>at-rest USDC withdrawable via ZK proof<br/>exposure = residual buffer only FC-7"]:::contract
    STUCK{In-flight ACTIVE bets<br/>with no order placed?}:::contract
    SIGN["Operator can still SIGN attestations off-chain<br/>(ban blocks placement, not local signing)"]:::signer
    REFUND[User reclaims via betCancellationCredit<br/>using FAILED attestation]:::fe
    LAST["Permanently-gone operator (lost keys):<br/>owner adminCancelBet after 3-7d timelock → FAILED"]:::admin

    BAN --> DET --> HALT --> SAFE
    HALT --> STUCK
    STUCK -- operator alive --> SIGN --> REFUND
    STUCK -- operator gone --> LAST --> REFUND

    classDef poly fill:#fee2e2,stroke:#dc2626,color:#450a0a
    classDef signer fill:#ffedd5,stroke:#ea580c,color:#431407
    classDef contract fill:#bbf7d0,stroke:#16a34a,color:#052e16
    classDef fe fill:#ccfbf1,stroke:#0d9488,color:#06302b
    classDef admin fill:#e2e8f0,stroke:#475569,color:#0f172a
```

---

## 4.3 Backend index/cache + note recovery (FC-12)

The proof-relay mirrors the **public** on-chain state into SQLite (`merkle.db`) so no client ever re-scans the chain. It scans **once** (windowed + cursor-persisted), then tracks new blocks incrementally. Privacy: it stores only opaque commitments + anonymous events; the secret-based matching stays in the browser.

```mermaid
flowchart TB
    subgraph CHAIN["🟩 On-chain (source of truth)"]
        TREE[🌳 CommitmentMerkleTree<br/>emits LeafInserted idx,leaf,newRoot]:::contract
        VLT[📜 Vault<br/>emits Deposited / BetAuthorized /<br/>SettlementCredited / … / MarketResolved]:::contract
    end
    subgraph RELAY["📨 Proof Relay — backend index/cache (SQLite merkle.db)"]
        CMT["CachedMerkleTree<br/>append leaf → O(32) path nodes<br/>ASSERT computed root == event.newRoot<br/>(per-leaf check) · currentRoot() cross-check"]:::relay
        VEI["VaultEventIndex<br/>indexes 11 lifecycle events (args+block_ts)<br/>Deposited = ONLY wallet-keyed row"]:::relay
        MP[/"GET /merkle-path/:commitment<br/>O(32) lookup · 0 chain calls<br/>fallback: on-the-fly compute"/]:::relay
        RD[/"GET /recovery-data/:depositor<br/>wallet deposits + ALL anon spends<br/>+ blockTimestamps + feeConfig + currentRoot"/]:::relay
        EV[/"GET /events?limit=N (Explorer)"/]:::relay
    end
    subgraph BROWSER["🖥️ User browser — RESTORE (secret-dependent ⟹ client-only)"]
        R1["1. fetch /recovery-data (no client chain scan)"]:::fe
        R2["2. secret_i = deriveSecret(wallet, i) per deposit index"]:::fe
        R3["3. replay events; keep only those whose<br/>nullifier == OWN derived nullifier"]:::fe
        R4["4. rebuild notes (incl. credit notes) → localStorage"]:::fe
        R1 --> R2 --> R3 --> R4
    end

    TREE -- "scan once → incremental<br/>(RetryingJsonRpcProvider · chunked)" --> CMT
    VLT -- "scan once → incremental" --> VEI
    CMT --> MP
    VEI --> RD
    VEI --> EV
    MP -. "proof witnesses" .-> BROWSER
    RD --> R1

    classDef contract fill:#bbf7d0,stroke:#16a34a,color:#052e16
    classDef relay fill:#ede9fe,stroke:#7c3aed,color:#2e1065
    classDef fe fill:#ccfbf1,stroke:#0d9488,color:#06302b
```

> **Trust:** a malicious/incomplete backend can only cause *incomplete* recovery (omitting events) — it cannot de-anonymize (no secret server-side; only `Deposited` is wallet-keyed) and cannot forge notes (the replay acts only on events matching the wallet's own derived nullifier). Open hardening: client verifies the served `currentRoot` vs on-chain. The on-chain tree stays authoritative; the frontend keeps a direct-chain fallback.

---

## 4.4 Settlement resolver (poll + filtered ctf.on)

`CTF.ConditionResolution` is a **global** event (every Polymarket market fires it). The resolver must act only on the vault's **own** markets, and must work even on RPCs that don't support live filters or pruned history. Two complementary paths, both feeding one idempotent handler that runs **resolveMarket FIRST**, then best-effort redemption.

```mermaid
flowchart TB
    subgraph DETECT["Detection (two paths)"]
        ONEV["🟧 ctf.on('ConditionResolution')<br/>(live; dev/Anvil + filter-capable RPCs)"]:::signer
        POLL["🟧 poll loop over tracked_markets<br/>ctf.payoutDenominator(cond) STATE read<br/>(works on pruned/filter-less RPCs — no getLogs)"]:::signer
        FILT{conditionId ∈ tracked_markets?<br/>(vault's OWN bets only)}:::signer
        ONEV --> FILT
        POLL --> FILT
    end
    FILT -- no --> IGN["ignore (foreign global market)<br/>— prevents resolving every Polymarket market = RPC storm"]:::poly
    FILT -- yes --> H["handleResolution(conditionId)"]:::signer
    H --> RM["① resolveMarket(market_id)<br/>reads CTF ELEMENT accessor:<br/>payoutNumerators(cond,i) + getOutcomeSlotCount<br/>⟹ pendingCredit[circuit_key][side] · MarketResolved"]:::contract
    RM --> RP["② best-effort redemption pipeline<br/>redeem CTF → offramp pUSD → acknowledgePolymarketReturn"]:::signer
    RM -. "settlement enabled even if ② fails" .-> DONE([users can now creditSettlement]):::fe

    classDef signer fill:#ffedd5,stroke:#ea580c,color:#431407
    classDef contract fill:#bbf7d0,stroke:#16a34a,color:#052e16
    classDef poly fill:#fee2e2,stroke:#dc2626,color:#450a0a
    classDef fe fill:#ccfbf1,stroke:#0d9488,color:#06302b
```

> `tracked_markets` is populated per-bet by the event-listener (raw conditionId from the market registry), so the resolver knows the vault's markets without a historical `getLogs`. `resolveMarket` runs **before** the fragile relayer-dependent redemption so a redeem failure never blocks users from settling; redemption retries separately.

---

## 4.5 RPC resilience & requirements

Every backend service + the frontend read Polygon through an RPC. Two RPCs were ruled out the hard way; the resilience layer makes the rest survivable.

```mermaid
flowchart TB
    REQ["RPC must be: ARCHIVE/full (not pruned)<br/>+ usable eth_getLogs block range"]:::admin
    P1["❌ publicnode (pruned)<br/>'History has been pruned for this block'<br/>⟹ can't rebuild tree / index"]:::poly
    P2["❌ Alchemy FREE<br/>eth_getLogs capped at 10-block range<br/>⟹ ~10k requests/scan + blows monthly CU"]:::poly
    OK["✅ paid/dedicated archive node<br/>(or LOG_SCAN_CHUNK=10 for short free-tier testing)"]:::contract
    REQ --- P1
    REQ --- P2
    REQ --- OK

    subgraph LAYER["Resilience baked in (any tier)"]
        RP1["RetryingJsonRpcProvider<br/>retries HTTP/JSON-RPC 429 on EVERY method<br/>(the SINGLE retry layer — chunkers do NOT also retry)"]:::signer
        RP2["log scans: windowed + cursor-persisted<br/>(resume after restart) + chunk-env"]:::signer
        RP3["backend index/cache (§4.3)<br/>⟹ per-action proofs need NO scan"]:::relay
        RP4["frontend ethCall: retries 429,<br/>NEVER fabricates state on error"]:::fe
    end

    classDef admin fill:#e2e8f0,stroke:#475569,color:#0f172a
    classDef poly fill:#fee2e2,stroke:#dc2626,color:#450a0a
    classDef contract fill:#bbf7d0,stroke:#16a34a,color:#052e16
    classDef signer fill:#ffedd5,stroke:#ea580c,color:#431407
    classDef relay fill:#ede9fe,stroke:#7c3aed,color:#2e1065
    classDef fe fill:#ccfbf1,stroke:#0d9488,color:#06302b
```
