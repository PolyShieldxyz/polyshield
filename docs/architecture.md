# Architecture: Polyshield

**Version:** 0.1 (Design Phase)
**Status:** No code written. This document is the canonical system design.

---

## 1. System Overview

Polyshield is a ZK-based privacy vault that sits on top of Polymarket. It allows sophisticated traders to place bets on Polymarket without revealing their identity as the bettor. The vault holds a single Polymarket account (EOA). All bets appear on-chain as coming from that address.

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
- `recentRoots[30]` — Rolling window of last 30 Merkle roots. Accepted in proofs to handle latency between tree updates and proof submission.
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
- `resolveMarket(bytes32 market_id, uint64 payout_per_share)` — Called exclusively by `signingLayerOperator` after the Deposit Wallet's CTF tokens for this market have been redeemed and USDC is back in the Vault. Verifies `payout_per_share` against `ctf.payoutNumerators[conditionId]` on-chain (the Vault must know the `conditionId` for each `market_id` — stored when `authorizeBet` records `betRecords`). Stores the value in `pendingCredit[market_id]`. Emits `MarketResolved(market_id, payout_per_share)`. Reverts if `pendingCredit[market_id]` is already set (idempotency guard). This call gates all subsequent `creditSettlement` calls for this market.

#### Verifier Contracts

Auto-generated from Noir circuits via `nargo codegen-verifier`. One per circuit type, or a single universal verifier if using a universal SNARK setup.

Deployed separately from `Vault.sol` and registered via `Vault.setVerifier(proofType, verifierAddress)`.

### 2.2 Off-Chain Backend

#### Signing Layer (v1: Centralized)

A Node.js service that:
1. Listens for `BetAuthorized` events from the Vault contract.
2. Decodes the bet parameters (`market_id`, `position_id`, `bet_amount`, `price`, `expected_shares`) from the event.
3. Constructs a Polymarket CLOB order using the official `@polymarket/clob-client-v2` SDK. Order type: **FOK (Fill-Or-Kill)** exclusively. Maker and signer are both set to the Deposit Wallet address.
4. Signs the order using the **POLY_1271** signature type (ERC-7739-wrapped ERC-1271). The signing key is the vault EOA (owner of the Deposit Wallet).
5. Sends the signed order to the Polymarket CLOB API using **L2 HMAC authentication** headers (`POLY_ADDRESS`, `POLY_SIGNATURE`, `POLY_TIMESTAMP`, `POLY_API_KEY`, `POLY_PASSPHRASE`). L2 API credentials are stored in secrets manager alongside the signing key.
6. Maintains a **heartbeat loop** (every 5 seconds) to keep the CLOB session alive. If the heartbeat stops, all open orders are cancelled within ~15 seconds — this is a useful safety property but must not be allowed to lapse unexpectedly.
7. Checks the FOK result:
   - If filled: records the fill locally. The Vault's `betRecords` entry is now complete.
   - If `FOK_ORDER_NOT_FILLED_ERROR`: the note has already been debited on-chain. Must trigger a Bet Cancellation Credit (see Q7a in `open-questions.md`). **This path is not yet implemented and is a blocker.**
8. Implements a dead-man circuit breaker: if the Polymarket API returns 403 or an account-flagged error, halts all signing and alerts.

**Secrets managed by the Signing Layer (v1):**
- Vault EOA private key (signs POLY_1271 orders and Deposit Wallet batches)
- CLOB L2 API key, secret, and passphrase (HMAC authentication for CLOB endpoints)
- Both must live in secrets manager. Never hardcoded. Never logged.

**v2 upgrade path: TEE Signer**
Move the EOA key into an AWS Nitro Enclave. The enclave exposes an attestation document (COSE_Sign1 format, containing the enclave's PCR measurements) that can be verified on-chain via a custom attestation verifier contract. The Vault can require that a valid TEE attestation be registered before accepting any bet authorization proofs, ensuring the Signing Layer runs correct code.

**TSS/FROST: not on the roadmap.** Threshold signing was evaluated and dropped. Signing latency from a multi-party ceremony is incompatible with Polymarket's order freshness window, and the added operational complexity is not justified given TEE achieves the same trust model improvement. The trust evolution path ends at v2 (TEE).

#### Polymarket Indexer

A Node.js sub-service that:
- Listens for `CTF.ConditionResolution` events on Polygon mainnet. CTF address: `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` (verified).
- For each resolved market where the Deposit Wallet held shares: calls `CTF.payoutNumerators(conditionId)` and `CTF.payoutDenominator(conditionId)` to compute `payout_per_share` for each outcome. Computes `payout_per_share = payoutNumerators[i] * 1e6 / payoutDenominator` (result in pUSD micro-units).
- Triggers the Signing Layer to submit a `WALLET` batch via the Polymarket relayer calling `CTF.redeemPositions(pUSD, bytes32(0), conditionId, indexSets)` from the Deposit Wallet, converting winning CTF tokens back to pUSD.
- Stores settlement records in a local database keyed by `market_id`.
- Exposes: `GET /settlement/:market_id` → `{ conditionId, position_id, payout_per_share, block_number, outcome }` for the frontend WASM prover to fetch witness data for Settlement Credit proofs.

**Share balance query path:** To determine which markets the vault has positions in, query `CTF.balanceOf(depositWalletAddress, positionId)` — shares are held by the **Deposit Wallet**, not the signing EOA.

#### Proof Relay

A stateless HTTP relay service. Accepts ZK proofs from users (who may want to submit anonymously) and forwards them to the Polygon RPC to call Vault contract functions. Gas is paid by the relay (with fees, or subsidized). Can be operated by anyone; the relay cannot forge or manipulate proofs.

### 2.3 Frontend

Next.js application. All cryptographic operations (note generation, proof generation) run in-browser via WASM. No secrets ever leave the browser.

Flows:
- **Deposit:** Connect wallet. Enter amount. Client generates `secret` via `crypto.getRandomValues()`. Computes commitment. Displays note to user with mandatory save confirmation. Calls `Vault.deposit(commitment)`.
- **Bet Proposal:** Enter market URL or ID. Select side, amount, and limit price. Client fetches the current Merkle root and the market's `position_id` from the Indexer. Generates Bet Authorization proof (WASM, 30-120 seconds). POSTs the proof and public inputs to the **Proof Relay** — NEVER calls `Vault.authorizeBet()` directly from the user's connected wallet (see T19 in `threat-model.md`). Displays pending status. Notifies user when `BetAuthorized` event is observed on-chain and when the CLOB fill is confirmed by the Signing Layer.
- **Withdrawal:** User enters saved note. Client fetches current Merkle root. Fetches settlement records for any credited markets. Computes final balance. Generates Withdrawal proof. Submits via relay or direct.

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
     |                |                 |-- CollateralOfframp: convert pUSD -> USDC      |
     |                |                 |-- resolveMarket(market_id, payout_per_share)-->|
     |                |                 |                             |-- verify against  |
     |                |                 |                             |   payoutNumerators|
     |                |                 |                             |-- store in        |
     |                |                 |                             |   pendingCredit   |
     |                |                 |                             |-- emit            |
     |                |                 |                             |   MarketResolved  |
     |                |<-- store settlement record                    |                  |
```

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
| Vault contract | Trustless (public, audited code) | Yes | Yes |
| ZK Verifier | Trustless (math) | Yes | Yes |
| Signing Layer | Trusted not to front-run or censor | Operator | TEE code |
| Indexer | Trusted for data availability | Operator | Operator |
| Proof Relay | Trustless (stateless, cannot forge) | Yes | Yes |
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
- **Q5:** Concurrent open positions -- gates whether partial withdrawal is possible.
- **Bet descriptor privacy:** Whether to encrypt bet descriptors on-chain -- gates the `authorizeBet` function signature and the Signing Layer's decryption path.
- **Multi-EOA rotation** -- gates the `polymarketSigner` field design in the Vault.
