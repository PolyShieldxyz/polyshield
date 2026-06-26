# Architecture: Polyshield

**Version:** 0.4 (Mainnet test phase)
**Status:** Implemented and deployed to Polygon mainnet for testing. Contracts (UUPS proxies), 9 Groth16 circuits, all backend services, and the Next.js frontend are live. This document is the canonical system design and reflects the current implementation.

---

## 1. System Overview

Polyshield is a ZK-based privacy vault that sits on top of Polymarket. It allows sophisticated traders to place bets on Polymarket without revealing their identity as the bettor. The vault holds a single Polymarket account (EOA). All bets appear on-chain as coming from that address.

### Component Map (who talks to whom)

```
                                  ┌──────────────────────────────────────────────┐
                                  │                  USER BROWSER                  │
                                  │  Next.js + Wagmi. Holds the wallet-derived     │
                                  │  SECRET (never leaves the browser). Generates  │
                                  │  all ZK proofs client-side (snarkjs WASM).     │
                                  └───┬───────────────┬───────────────┬───────────┘
              deposit() ONLY          │ (proofs +      │ (read merkle  │ (read recovery
        (only tx from user wallet)    │  public        │  path / events│  data / events
                                  │   │  inputs)       │  — never      │  — never scans
                                  │   │                │  scans chain) │  chain itself)
                                  ▼   ▼                ▼               ▼
   ┌───────────────┐   ┌──────────────────┐   ┌──────────────────────────────────────┐
   │ Polygon RPC   │   │   PROOF RELAY     │   │   PROOF RELAY (backend index layer)    │
   │ (ARCHIVE/full │   │  relays proofs →  │   │  • CachedMerkleTree  → /merkle-path    │
   │  node — see   │◄──┤  Vault (pays gas) │   │  • VaultEventIndex   → /recovery-data  │
   │  §RPC Reqs)   │   │  user wallet is   │   │                      → /events         │
   │               │   │  NEVER the tx.from│   │  mirrors on-chain state in SQLite so   │
   └──────┬────────┘   └─────────┬─────────┘   │  clients never re-scan the chain       │
          │                      │             └───────────────────┬────────────────────┘
          │ reads/writes         │ Vault calls                     │ scans events (once, then incremental)
          ▼                      ▼                                 │
   ┌──────────────────────────────────────────────────────────────┼─────────────────┐
   │                         POLYGON (on-chain)                     │                 │
   │  Vault (UUPS proxy) ── CommitmentMerkleTree ── NullifierReg ── 9× Groth16 verif. │
   │      │  holds USDC, betRecords, pendingCredit, feeConfig                          │
   │      │  emits Deposited / BetAuthorized / SettlementCredited / … / MarketResolved │
   └──────┼───────────────────────────────────────────────────────────────────────────┘
          │ vault EOA owns ↓                          ▲ resolveMarket / credit / fund (operator-only)
          ▼                                           │
   ┌──────────────────┐         ┌──────────────────────────────────────────────────┐
   │ Polymarket CLOB  │◄────────┤              SIGNING LAYER (vault EOA key)          │
   │ + CTF + Relayer  │  orders │  • event-listener: BetAuthorized → submit CLOB order│
   │ (Deposit Wallet  │  (FAK/  │  • settlement-resolver: CTF resolved → resolveMarket│
   │  holds pUSD/CTF) │  GTC/GTD)│  • JIT collateral funding · FC-9 signed attestations│
   └──────────────────┘         └──────────────────────────────────────────────────┘

   Trust: the user's SECRET and the wallet↔bet link live ONLY in the browser. Every backend
   service sees only PUBLIC, anonymous on-chain data (opaque commitments/nullifiers). The signing
   layer holds the vault EOA key (v1 centralized → v2 TEE). See §4 Trust Model.
```

### Privacy Invariants

**What is hidden:** which depositor authorized which bet.
**What is NOT hidden (by design):** that a wallet deposited into the Vault. The deposit is on-chain and linkable to the depositor's address. This is an accepted trade-off.

### What Polyshield Is NOT

- It is not a mixer or tumbler. It does not break the link between a user's wallet and the vault.
- It is not a copy-trading protocol. Each depositor controls their own bets.
- It is not a fund. The vault does not trade autonomously.

---

## 2. System Layers

### 2.1 On-Chain (Polygon)

#### Vault Contract (`Vault.sol`)

The central contract. Entry point for all user interactions.

State:
- `CommitmentMerkleTree` — Poseidon-hashed append-only tree (depth 32) of all note commitments.
- `NullifierRegistry` — Mapping `nullifier => bool`. Marks spent notes.
- Merkle root history — a rolling **1024-root** window (FC-3, implemented) with O(1) `mapping(bytes32 => bool) knownRoots` membership. `currentRoot` is the single source of truth for the latest root; `insert` maintains the window via a `rootRing` keyed by `seq % 1024`, evicting the oldest on overflow. Accepted in proofs to handle latency between tree updates and proof submission. (Replaced the older `recentRoots[30]` block.)
- `usdc` — Address of USDC on Polygon (user-facing collateral). The Vault accepts and pays out in USDC only. Internally, USDC is converted to pUSD via `CollateralOnramp` (`0x93070a847efEf7F70739046A929D47a521F5B8ee`) before being sent to the Deposit Wallet, and converted back via `CollateralOfframp` (`0x2957922Eb93268531d39fAcCA3B4dC5854`) on return. All ZK circuit arithmetic is in USDC micro-units; pUSD is invisible to circuits and users.
- `depositWallet` — Address of the vault's Polymarket Deposit Wallet (the ERC-1967 proxy that holds pUSD and CTF shares for Polymarket trading).
- `polymarketSignerEOA` — The vault's signing EOA (owner of the Deposit Wallet). Registered for transparency.
- `verifiers` — Mapping from proof type to verifier contract address.
- `betRecords` — Mapping `nullifier_of_bet => BetRecord { market_id, position_id, expected_shares, bet_amount, status }`. Populated at `authorizeBet`, read at `creditSettlement` and `betCancellationCredit`. `status` is one of: `ACTIVE`, `FILLED`, `FAILED`, `CREDITED`, `CANCELLED_CREDITED`. The `bet_amount` field is needed so the Vault can inject it into the Bet Cancellation Credit and N/A Cancellation Credit proofs without trusting user input.
- `cumulativeDeposits` — `mapping(address => uint256)`. Tracks total USDC deposited per address. Enforces the $50,000 USDC per-address cap in MVP. Checked at `deposit()` time. No privacy cost since depositor addresses are already public by design.
- `pendingCredit` — `mapping(bytes32 => uint64)`. `market_id => payout_per_share`, written by `resolveMarket` after the Signing Layer has confirmed that the Deposit Wallet's CTF tokens for this market have been redeemed and pUSD converted back to USDC. Users cannot submit `creditSettlement` proofs for a market until this mapping has an entry for it. The Vault injects this value into the Settlement Credit verifier — users do not supply it.

Functions:
- `deposit(bytes32 commitment, uint256 amount)` — Inserts commitment into Merkle tree, calls `USDC.transferFrom(msg.sender, address(this), amount)`. Note: the commitment is `Poseidon(secret, amount, nonce)`, but the contract cannot validate `amount` from the commitment (it does not know the secret). `amount` is a separate parameter checked against the transfer.
- `authorizeBet(bytes proof, BetAuthPublicInputs inputs)` — Verifies Bet Authorization proof. Checks nullifier not spent. Inserts new commitment. Marks old nullifier spent. Stores `betRecords[inputs.nullifier] = { market_id, position_id, expected_shares }`. Emits `BetAuthorized(inputs.nullifier, inputs.market_id, inputs.position_id, inputs.expected_shares, inputs.bet_amount, inputs.price, inputs.new_commitment)`.
- `creditSettlement(bytes proof, SettlementCreditPublicInputs inputs)` — Reads `betRecords[inputs.nullifier_of_bet].expected_shares`, injects it as a public input to the verifier (user cannot supply a different value), verifies Settlement Credit proof, updates note commitment, emits `SettlementCredited`.
- `withdraw(bytes proof, WithdrawalPublicInputs inputs)` — Verifies Withdrawal proof. Checks nullifier. Transfers USDC to `recipientAddress` where `Poseidon(recipientAddress) == inputs.recipient_hash`.
- `reportFOKFailure(bytes32 nullifier_of_bet)` — Called exclusively by the registered Signing Layer operator address when a FOK order fails to fill after `authorizeBet` was already confirmed on-chain. Sets `betRecords[nullifier_of_bet].status = FAILED`. Emits `FOKFailed(nullifier_of_bet)`. Only callable by `signingLayerOperator` (a stored address, not the vault EOA). This enables the user to subsequently submit a Bet Cancellation Credit proof.
- `betCancellationCredit(bytes proof, BetCancellationPublicInputs inputs)` — Verifies Bet Cancellation Credit proof. Checks `betRecords[inputs.nullifier_of_bet].status == FAILED`. Injects `betRecords[inputs.nullifier_of_bet].bet_amount` as a public input to the verifier (user cannot inflate). Updates note, marks status `CANCELLED_CREDITED`.
- `naCancellationCredit(bytes proof, NACancellationPublicInputs inputs)` — Verifies N/A Cancellation Credit proof. Checks that the CTF condition resolved as N/A (all-zero `payoutNumerators`). Injects `betRecords[inputs.nullifier_of_bet].bet_amount`. Updates note.
- `resolveMarket(bytes32 market_id)` — Called exclusively by `signingLayerOperator`. **Derives the payout on-chain** (the operator supplies no payout value): reduces `market_id` to the BN254 `circuit_key`, reads the per-outcome payouts directly from the real Gnosis CTF, and stores `pendingCredit[circuit_key][outcome_side]` + `marketResolvedAt[circuit_key]` + `conditionIdOf[circuit_key]`. Reverts `MarketAlreadyResolved` if already set (idempotency), `ConditionNotResolved` if `payoutDenominator==0`, `NotNA` if all-zero. This gates all subsequent `creditSettlement` calls for this market. **CTF ABI (critical):** the real Gnosis CTF exposes `payoutNumerators` as the element accessor `payoutNumerators(conditionId, index) → uint256` plus `getOutcomeSlotCount(conditionId)` — there is **no** `payoutNumerators(conditionId) → uint256[]` array getter (that signature exists only on the test `MockCTF` and reverts on mainnet). `resolveMarket` and `naCancellationCredit` therefore loop `i ∈ [0, getOutcomeSlotCount)` reading one element at a time (see `interfaces/ICTF.sol`).

  > **BetStatus enum (current):** `ACTIVE(0)`, `FILLED(1)`, `FAILED(2)`, `CREDITED(3)`, `CANCELLED_CREDITED(4)`, `CLOSING(5)`, `CLOSED_CREDITED(6)`, `PARTIAL_FILLED(7)`, `RESTING(8)`. Per FC-9, on-chain status is advanced only by `authorizeBet` (→ACTIVE) and the credit functions — the operator no longer pushes status with `report*`; instead it signs an EIP-712 `OperatorAttestation` the user submits with their credit proof (the Vault recovers the signer and injects the attested values). See `future-changes.md` FC-9.

#### Verifier Contracts

Snarkjs-generated Groth16 verifiers (BN254), one per circuit type, built through the `packages/circuits/pipeline` pipeline. Each generated file pairs a stateless `<Name>G16Base` (the pairing math + hardcoded verification key) with a UUPS-upgradeable `<Name>Verifier` adapter implementing `IVerifier`.

Deployed separately from `Vault.sol` (each behind its own proxy) and registered in the Vault verifier slots via the **48h-timelocked** `proposeVerifier` / `acceptVerifier` flow. Adopting a new verification key without a full proxy migration is also possible via the adapter's owner-only `setBase(address)` (an instant, separate lever).

#### Upgradeability (UUPS / ERC-1967)

Every deployed contract — `Vault`, `CommitmentMerkleTree`, `NullifierRegistry`, `PoseidonT3Hasher`, and all 8 verifier adapters — is a UUPS **implementation behind an `ERC1967Proxy`**. The **proxy addresses are the permanent protocol addresses**; the implementation behind each proxy can be replaced to ship logic fixes without migrating state. Mechanics:

- Constructors are replaced by `initialize(...)` (guarded by OpenZeppelin's `initializer`); implementations call `_disableInitializers()` in their constructor so the logic contract itself can never be initialized.
- `_authorizeUpgrade` is gated by **plain `onlyOwner`, instant — no timelock.** This is a deliberate trust trade-off for the initial mainnet test (immediate hotfix capability) and the single largest trust assumption in the system: **the owner can replace any contract's logic in one transaction**, which is a fund-drain and de-anonymization vector. The owner role MUST be a multisig/HSM in production. See `threat-model.md` (T21).
- Storage is append-only: each contract reserves a trailing `__gap`, new state is added by shrinking the gap, and existing state is never reordered. `CommitmentMerkleTree`'s array layout (`poseidon, vault, zeros[32], filledSubtrees[32], recentRoots[30], currentRootIndex/nextIndex, __gap`) is frozen.
- Reentrancy uses `ReentrancyGuardTransient` (EIP-1153 transient storage, proxy-safe with no initializer; `evm_version = "cancun"`, supported on Polygon since the Napoli hardfork) rather than the constructor-based guard.
- Deployment uses the proxy pattern in `script/Deploy.s.sol` / `MockDeploy.s.sol` via `script/DeployLib.sol`, which predicts the Vault proxy address with `vm.computeCreateAddress` to resolve the Vault↔Tree↔NullifierRegistry initialization cycle.

### 2.2 Off-Chain Backend

Three Node.js services, each in its own container (`packages/backend/`): **signing-layer** (holds the vault EOA key), **proof-relay** (relays proofs + serves the backend index/cache), and **indexer** (settlement records). All three read the chain through a shared RPC and share a `RetryingJsonRpcProvider` pattern (see §RPC Requirements).

#### Signing Layer (v1: Centralized — holds the vault EOA key)

**(a) Bet event-listener.** Polls `BetAuthorized` via `getLogs` (a live `vault.on` subscription dies on filter-less public RPCs) using a **windowed, cursor-persisted, rate-limit-aware** scan (`logScan.ts`): the cursor advances to the scanned head and persists in the data volume, so it scans history once and then only new blocks. For each fresh bet it resolves the real Polymarket `tokenId`/`conditionId` from the **market registry** (`marketRegistry.ts`, mirrors Gamma), records the market in `tracked_markets`, then submits the order. **Order types (FC-4):** Market = **FAK**, Limit = resting **GTC/GTD** (dispatched on the frontend's order-type intent; FOK is a legacy primitive). Orders are POLY_1271-signed by the vault EOA and sent with L2 HMAC auth.

**(b) Fill tracking + FC-9 attestations.** A user-channel websocket tracks resting orders; on a terminal state the operator signs an EIP-712 `OperatorAttestation{nullifierOfBet, reportType(FILLED/FAILED/PARTIAL/SOLD), amountA, amountB}` (single-write per bet) which the user later submits with their credit proof. The operator no longer pushes status on-chain (`report*` removed).

**(c) JIT collateral funding (Option 3 / FC-7).** Nothing is deployed at deposit time. Just before order submission, if the Deposit Wallet is short, `Vault.fundPolymarketWallet(shortfall)` moves USDC→pUSD→Deposit Wallet. pUSD left after a no-fill is reused as a residual buffer. All Deposit-Wallet actions go through `DepositWalletExecutor` (mock relayer locally, Polymarket builder relayer on mainnet).

**(d) Settlement resolver.** Detects resolution two ways: a live `ctf.on("ConditionResolution")` (works on dev/Anvil and on RPCs that support filters) **filtered to the vault's own `tracked_markets`** (the CTF event is global — without the filter it would try to resolve every Polymarket market and storm the RPC), AND a **poll fallback** that iterates `tracked_markets` and checks each via the CTF `payoutDenominator` state read (works even on pruned/filter-less RPCs — no historical `getLogs`). On resolution it runs the **redemption pipeline** (`redemptionPipeline.ts`): **resolveMarket FIRST** (so users can settle even if redemption fails), **then** best-effort redeem CTF → offramp pUSD → `acknowledgePolymarketReturn`.

**(e) Resilience.** The provider is a `RetryingJsonRpcProvider` (retries 429 on every method); all log scans page in chunks (`LOG_SCAN_CHUNK`, default 10000 — set to **10** for Alchemy free) and the chunkers do NOT re-retry 429 (the provider is the single retry layer — de-nested to avoid multi-minute hangs). Global `unhandledRejection`/`uncaughtException` guards prevent a stray RPC error from crashing the process (the deliberate dead-man circuit breaker still `process.exit`s on a Polymarket 403/ban).

**Secrets (v1):** vault EOA private key + CLOB L2 creds (env only; never logged). **v2:** move the key into an AWS Nitro TEE; the Vault can require a valid attestation. **TSS/FROST: dropped** (latency incompatible with order freshness).

#### Indexer

Listens for `CTF.ConditionResolution`, stores settlement records keyed by conditionId, exposes `GET /settlement/:market_id`. (Note: the frontend reads resolution/payout directly from `Vault.pendingCredit`/`marketResolvedAt` on-chain; the indexer is supplementary.)

#### Proof Relay — relay + backend index/cache (`packages/backend/proof-relay`)

Three roles. **Privacy: the relay/index see only PUBLIC, anonymous on-chain data — never a secret, never a wallet↔note link** (only `Deposited` carries a wallet, and deposits are public by design).

1. **Proof relay.** Stateless: accepts a user's ZK proof + public inputs and submits the Vault call (`authorizeBet`/`creditSettlement`/`partialFillCredit`/`withdraw`/…). **Gas is paid by the relayer key — the user's wallet is NEVER `tx.from`** (the privacy invariant; see T19). Cannot forge proofs.

2. **`CachedMerkleTree` (`merkleTree.ts`) → `GET /merkle-path/:commitment`.** A backend mirror of the on-chain `CommitmentMerkleTree`, maintained incrementally (append-only node map, O(32) insert/serve) and persisted to SQLite. Built so a proof's merkle path is an **O(32) in-memory lookup with zero chain calls**, instead of re-scanning all `LeafInserted` history per request (the old behavior — devastating at scale + impossible under a metered RPC). **Per-leaf correctness:** the `LeafInserted(index, leaf, newRoot)` event carries the chain's root after each insert, so every appended leaf's computed root is asserted `== newRoot`; a mismatch marks the cache inconsistent and the endpoint falls back to authoritative on-the-fly computation. A periodic `currentRoot()` cross-check is a second net.

3. **`VaultEventIndex` (`eventIndex.ts`) → `GET /recovery-data/:depositor` and `GET /events`.** Indexes all note-lifecycle Vault events (Deposited, BetAuthorized, SettlementCredited, BetCancellationCredited, NACancellationCredited, PartialFillCredited, Withdrawn, BetSold, PositionClosed, Consolidated, MarketResolved) into SQLite so clients **recover notes and view activity without scanning the chain themselves**:
   - `/recovery-data/:depositor` → that wallet's `Deposited` events + ALL anonymous spend events + block timestamps + `feeConfig` + `currentRoot`. The client matches its own notes locally with its secret (see §2.3 / Recovery flow).
   - `/events?limit=N` → all indexed events for the public Explorer.

Both the cache and the index use the same resilient one-time scan (windowed, cursor-persisted, chunk-env, `RetryingJsonRpcProvider`), then run incrementally. See **§2.4** for the full picture.

### 2.3 Frontend

Next.js + Wagmi. All cryptography (note derivation, proof generation via snarkjs WASM) runs in-browser. **No secret ever leaves the browser.** Secrets are **wallet-derived (P3+)**. **V2 (FC-13, default):** one master-seed signature per session — `master_seed = keccak256(wallet.sign("PolyShield master seed\nAddress:{W}\nVersion:2"))`, `secret_i = keccak256(master_seed ‖ uint32(i)) mod p` — held in memory only, so the wallet IS the backup and a whole session needs one signature. **V1 (legacy):** `secret = keccak256(wallet.signMessage("PolyShield deposit derivation\nAddress:{W}\nIndex:{i}\nVersion:1")) mod p`. The note cache (commitment/nullifier/balance/nonce/spent/derivationVersion, NOT the secret) is persisted **encrypted in IndexedDB** (FC-13, non-extractable AES-GCM key) and mirrored to an in-memory working set; the master seed is never persisted.

Flows:
- **Deposit:** the **only** transaction the user's wallet ever sends. Derives the secret, computes `Poseidon4(secret, amount, 0, owner)`, generates the mandatory deposit-binding proof (FC-2), calls `Vault.deposit(proof, commitment, amount)`.
- **Bet / Settle / Close / Cancel / Withdraw:** generate the proof client-side, fetch the **merkle path from the proof-relay** (`/api/merkle-path` → `CachedMerkleTree`, not a client chain scan), and **POST the proof to the Proof Relay** — the frontend NEVER calls a state-mutating Vault function from the user's wallet (T19). Cheap on-chain reads (e.g. `pendingCredit`, `betRecords`) use a resilient `ethCall` helper that retries rate-limits and never fabricates state on error (a transient 429 must not flip a resolved bet to "pending").
- **Restore / recovery (P3+):** rebuilds the local note cache by fetching `/api/recovery-data/:wallet` from the backend (NOT a client chain scan), then mapping each on-chain `Deposited` commitment to its index via the free V2 derivation (one master-seed signature; legacy V1 per-index signing only as a fallback) and replaying the events locally to match its own notes. An all-V2 wallet restores in ONE signature; a silent reconcile auto-syncs new on-chain notes when the seed is already unlocked, and a determinate progress bar drives the manual Restore/Sync. See §2.4 and FC-13.
- **Explorer:** reads `/api/events` (backend index), not a client chain scan.

---

### 2.4 Backend Indexing, Caching & Recovery Layer

**Why it exists.** Polyshield is a privacy system, so the **client** must do anything secret-dependent (note matching, proof generation). But the heavy, public, repeatable work — reconstructing the Merkle tree, enumerating events — should not be done by every client re-scanning the chain through its own RPC. That is slow, and on a metered RPC it is impossible (e.g. Alchemy's free tier caps `eth_getLogs` at a **10-block range**; ~100k blocks of history = ~10k requests). So the proof-relay maintains a backend mirror of the public on-chain state and serves it; the client fetches it and does the private matching locally.

**What is and isn't shared.** The backend stores only what is already public on-chain: opaque leaf commitments and anonymous spend events. The **secret, and therefore the wallet↔note link, never leaves the browser** — the backend cannot know which notes are whose (only `Deposited` is wallet-linked, and deposits are public by design). A malicious/incomplete backend can at worst cause *incomplete* recovery (omitting events); it cannot forge or steal notes, because the client's replay only acts on events whose nullifier matches the wallet's own derived nullifier.

```
        ON-CHAIN (source of truth)                 PROOF-RELAY  (backend mirror, SQLite: merkle.db)
 ┌──────────────────────────────────┐      one-time, then incremental, windowed + cursor-persisted
 │ CommitmentMerkleTree              │   ┌──────────────────────────────────────────────────────────┐
 │   emits LeafInserted(idx,leaf,    │──►│ CachedMerkleTree                                            │
 │           newRoot)                │   │  • append leaf → update O(32) path nodes                    │
 │ Vault                             │   │  • ASSERT computed root == event.newRoot  (per-leaf check) │──► GET /merkle-path/:commitment
 │   emits Deposited / BetAuthorized │   │  • currentRoot() cross-check                                │     (O(32) lookup, 0 chain calls;
 │   / SettlementCredited / …        │   └──────────────────────────────────────────────────────────┘      fallback: on-the-fly compute)
 │   / MarketResolved                │   ┌──────────────────────────────────────────────────────────┐
 │                                   │──►│ VaultEventIndex                                             │──► GET /recovery-data/:depositor
 └──────────────────────────────────┘   │  • indexes all 11 note-lifecycle events (args + block_ts)   │     { deposits(for wallet), spends(all,
              ▲                          │  • Deposited is the ONLY wallet-keyed row                   │       anonymous), blockTimestamps,
              │ scans via RetryingJson-  └──────────────────────────────────────────────────────────┘       feeConfig, currentRoot }
              │ RpcProvider (429 retry)                                                                 └─► GET /events?limit=N  (Explorer)
              │ + chunked getLogs (LOG_SCAN_CHUNK; =10 on Alchemy free)
              │
              ▼
   ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
   │ USER BROWSER — RESTORE / RECOVERY (secret-dependent → client-only)                              │
   │  1. GET /api/recovery-data/:wallet  ── fetch public events from the backend (no client scan)    │
   │  2. master_seed = keccak(sign(V2 msg)) ONCE; secret_i = keccak(master_seed‖i)  (V1 per-index    │
   │     signing only as a fallback for legacy commitments V2 can't match)                            │
   │  3. replay events locally, keeping only those whose nullifier == own derived nullifier           │
   │     → rebuild balances/nonces/spent-status; cheap state reads (pendingCredit/betRecords) on RPC  │
   │  4. result = the wallet's note set (incl. the +credit notes); encrypted IndexedDB cache repopulated │
   └──────────────────────────────────────────────────────────────────────────────────────────────┘
```

Both the cache and the index do exactly **one** historical scan (persisted across restarts), then track new blocks incrementally — so steady-state cost is "read the new blocks each poll," not the history. Trust hardening still open: a client-side check that the served `currentRoot` matches on-chain.

---

### 2.5 RPC Requirements (operational — important)

Every backend service and the frontend read Polygon through an RPC. The system has two hard requirements that ruled out the two RPCs first tried:

- **Full/archive history, not pruned.** Reconstructing the Merkle tree and indexing events needs `eth_getLogs` back to the deploy block. A pruned node (e.g. `publicnode`) returns *"History has been pruned for this block"* and cannot serve it.
- **A usable `eth_getLogs` block range.** **Alchemy's FREE tier caps `eth_getLogs` at a 10-block range** (`-32600 … up to a 10 block range`). With ~100k blocks of history that is ~10,000 requests per scan, which also blows the free monthly compute budget in steady state. → **Use a paid/dedicated RPC (no 10-block cap) or your own node for production.** For short free-tier testing, set `LOG_SCAN_CHUNK=10` so requests are valid (one-time scans then grind slowly but complete; they're windowed + cursor-persisted so they resume).

Resilience baked in regardless of tier: `RetryingJsonRpcProvider` (retries HTTP/JSON-RPC 429 on every method, the **single** retry layer), chunked + cursor-persisted log scans, the backend index/cache (so per-action proofs need no scan), and frontend reads that retry and never fabricate state.

---

## 3. Data Flows

### Deposit Flow

```
User browser                      Polygon
     |                               |
     |-- generate secret (CSPRNG) -->|
     |-- compute commitment       -->|
     |-- display note to user     -->|
     |-- user confirms save       -->|
     |-- USDC.approve(Vault, amt) -->| Vault contract
     |-- Vault.deposit(commitment)-->| inserts leaf into Merkle tree
     |<-- TxHash confirmed        ---|
```

### Bet Authorization Flow

The user's wallet address NEVER appears in the authorizeBet transaction. The Proof Relay submits on-chain on behalf of the user. See threat T19 in `threat-model.md`.

```
User browser          Proof Relay          Vault.sol         Signing Layer      Polymarket CLOB
     |                     |                   |                    |                  |
     |-- input: mkt/side/  |                   |                    |                  |
     |   amt/price         |                   |                    |                  |
     |-- fetch merkle_root |                   |                    |                  |
     |-- generate ZK proof |                   |                    |                  |
     |   (WASM, 30-120s)   |                   |                    |                  |
     |-- POST proof+inputs |                   |                    |                  |
     |   (ideally over Tor)|                   |                    |                  |
     |                 |-- authorizeBet(proof) |                    |                  |
     |                 |   tx.from=relayAddr   |                    |                  |
     |                 |       |-- verify ZK proof                  |                  |
     |                 |       |-- check nullifier not spent        |                  |
     |                 |       |-- store betRecords[nullifier]      |                  |
     |                 |       |-- insert new commitment            |                  |
     |                 |       |-- emit BetAuthorized               |                  |
     |                 |       |              |-- read BetAuthorized event             |
     |                 |       |              |-- build FOK order (POLY_1271)          |
     |                 |       |              |-- send heartbeat (every 5s)            |
     |                 |       |              |-- POST order (L2 HMAC auth) -------->  |
     |                 |       |              |<-- FOK result (filled or not) -------- |
     |                 |       |              |   if NOT filled: trigger Q7a recovery  |
     |<-- TxHash ------+-------+              |                    |                  |
```

### Settlement Credit Flow

There are two distinct phases. Phase 1 is fully operator-driven and requires no user action. Phase 2 is user-initiated.

**Phase 1 — Redemption and market resolution (Signing Layer / Indexer, no user involvement)**

```
CTF contract     Indexer              Signing Layer           Polymarket Relayer     Vault.sol
     |               |                     |                          |                  |
     |-- emit         |                     |                          |                  |
     |   Condition-   |                     |                          |                  |
     |   Resolution-->|                     |                          |                  |
     |                |-- notify Signing -->|                          |                  |
     |                |   Layer             |                          |                  |
     |                |                 |-- WALLET batch: ----------->|                  |
     |                |                 |   redeemPositions(          |                  |
     |                |                 |    pUSD, 0, conditionId,    |                  |
     |                |                 |    [1,2])                   |                  |
     |                |                 |   signed by vault EOA       |                  |
     |                |                 |                     |-- exec on Deposit Wallet |
     |                |                 |                     |   CTF tokens burned      |
     |                |                 |                     |   pUSD returned          |
     |                |                 |<-- batch confirmed -|                          |
     |                |                 |-- resolveMarket(market_id) ------------------->|
     |                |                 |   (FIRST — independent of redemption, so       |
     |                |                 |    users can settle even if redeem fails)      |
     |                |                 |                             |-- read CTF payouts|
     |                |                 |                             |   ELEMENT-by-index|
     |                |                 |                             |   (payoutNumerators|
     |                |                 |                             |    (cond,i) +     |
     |                |                 |                             |    getOutcomeSlot- |
     |                |                 |                             |    Count) — NOT an |
     |                |                 |                             |    array getter   |
     |                |                 |                             |-- store pendingCredit
     |                |                 |                             |   [circuit_key][side]
     |                |                 |                             |-- emit MarketResolved
     |                |                 |-- THEN best-effort: redeem CTF → offramp → ack  |
     |                |<-- store settlement record                    |                  |
```

The CTF read uses the real Gnosis element accessor (`payoutNumerators(conditionId, index)` + `getOutcomeSlotCount`) — there is no array getter on mainnet CTF. `resolveMarket` runs **before** the (fragile, relayer-dependent) redemption so a redeem failure never blocks users from settling; redemption is retried separately.

**Phase 2 — Settlement credit claim (user-initiated, after Phase 1 completes)**

```
User browser                   Indexer              Proof Relay          Vault.sol
     |                            |                      |                   |
     |-- fetch /settlement/mkt_id |                      |                   |
     |<-- { conditionId,          |                      |                   |
     |      payout_per_share,     |                      |                   |
     |      outcome }-------------|                      |                   |
     |-- generate Settlement      |                      |                   |
     |   Credit proof (WASM)      |                      |                   |
     |-- POST proof + inputs      |                      |                   |
     |   (nullifier_of_bet,       |                      |                   |
     |    new_commitment,         |                      |                   |
     |    market_id)          ----|--------------------->|                   |
     |                            |              |-- creditSettlement(proof) |
     |                            |              |   Vault injects:          |
     |                            |              |    payout_per_share from  |
     |                            |              |    pendingCredit[mkt_id]  |
     |                            |              |    shares_held from       |
     |                            |              |    betRecords[nullifier]  |
     |                            |              |-- verify proof            |
     |                            |              |-- update commitment       |
     |                            |              |-- emit SettlementCredited |
     |<-- confirmation ---------- | -------------|                           |
```

Note: `payout_per_share` fetched from the Indexer in Phase 2 is informational only — it helps the user's WASM prover understand what credit to expect, but the Vault does not accept it as a proof input. The Vault always reads `payout_per_share` from `pendingCredit[market_id]`, which was set by `resolveMarket` in Phase 1. Users cannot inflate their credit by supplying a different value.

### Withdrawal Flow

```
User browser                                  Vault.sol
     |                                             |
     |-- input: note (secret, balance, nonce)      |
     |-- compute final balance (sum of credits)    |
     |-- generate Withdrawal proof (WASM)          |
     |-- submit withdraw(proof)        ----------->|
     |                                   verify   |
     |                                   check nullifier
     |                                   transfer USDC to recipient
```

---

## 4. Trust Model Summary

| Component | Trust Assumption | v1 | v2 |
|---|---|---|---|
| Vault contract | Trustless (public code) — except the **instant onlyOwner UUPS upgrade** (T21): owner can replace logic in one tx → multisig/HSM in prod | Yes | Yes |
| ZK Verifier | Trustless (math) | Yes | Yes |
| Signing Layer | Trusted not to front-run or censor; holds the vault EOA key | Operator | TEE code |
| Indexer | Trusted for data availability | Operator | Operator |
| Proof Relay (relay) | Trustless — stateless, pays gas, **cannot forge proofs** | Yes | Yes |
| Proof Relay (index/cache) | Serves only PUBLIC, anonymous data; **cannot de-anonymize** (no secret, no wallet↔note link) and **cannot forge notes** (client matches by its own derived nullifier). Worst case = *incomplete* recovery. Hardening: client checks served `currentRoot` vs on-chain | Yes | Yes |
| RPC provider | Trusted for data availability + honest reads; must be archive + no 10-block getLogs cap (§2.5) | Operator | Operator |
| Polymarket | Trusted to honor orders and report settlements correctly | Yes | Yes |

Note: TSS/v3 has been dropped from the roadmap. The trust evolution path is v1 (centralized operator) → v2 (TEE/AWS Nitro) only.

---

## 5. Threat Model Summary

Full detail in `docs/threat-model.md`. Critical items:

- **Bet descriptor deanonymization:** On-chain public bet parameters allow statistical attribution. Encryption or batch submission required.
- **Timing correlation:** Sequential Merkle leaf timing can correlate deposits to bets. Need random delays or decoy leaves.
- **Signing layer front-running (v1):** Centralized operator can front-run bets. Mitigated in v2/v3.
- **Note loss:** User losing note = permanent fund loss. Note backup UX is critical.
- **Vault EOA ban:** Polymarket banning the vault EOA locks all users. Multi-EOA rotation plan needed.
- **Stale Merkle root:** Accept rolling window of last 30 roots to handle race conditions.

---

## 6. Unresolved Architecture Questions

See `docs/open-questions.md`. The following directly affect this architecture document and will cause revisions when resolved:

- **Q4:** How to prove CLOB share ownership in a ZK circuit -- gates the Settlement Credit proof design.
- **Q5 (RESOLVED, FC-16):** Concurrent open positions / partial withdrawal. Partial withdrawal (change note) is implemented; open-position payout stranding is fixed frontend-only via drain-to-dust + a one-click Settle & Withdraw flow.
- **Bet descriptor privacy:** Whether to encrypt bet descriptors on-chain -- gates the `authorizeBet` function signature and the Signing Layer's decryption path.
- **Multi-EOA rotation** -- gates the `polymarketSigner` field design in the Vault.
