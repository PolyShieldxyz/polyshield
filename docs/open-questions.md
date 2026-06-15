# Open Questions: Polyshield

**Purpose:** Live tracker of unresolved research and design questions.
**Format:** Each question has a status, owner, impact, and current best thinking.

Questions prefixed with [BLOCKER] gate implementation and must be resolved before code is written in the affected area.

---

## Signing Layer

### Q1 — Polymarket CLOB API compatibility

**Status:** Open
**Impact:** Signing Layer implementation
**Question:** Does Polymarket's CLOB API accept programmatically generated EIP-712 orders at scale without triggering rate limits or account bans? What are the rate limits? Does the API require a browser fingerprint, user agent, or other client-side signals that a backend service cannot provide?

**Research needed:**
- Inspect Polymarket's API authentication headers (is it just EIP-712 signature, or does it require additional session tokens?)
- Test submitting orders programmatically from a Node.js service to a testnet environment
- Review Polymarket's terms of service for programmatic trading restrictions
- Check if there is an official or unofficial API key system for institutional traders

**Current best thinking:** Polymarket's API appears to use EIP-712 signed orders submitted to a CLOB backend. The signed order is the authentication. No session tokens are visible in public documentation. However, behavioral fingerprinting (IP, request cadence, user agent) could still trigger bans.

---

### Q2 — TEE attestation verifiability on Polygon (Signing Layer v2)

**Status:** Open
**Impact:** Signing Layer v2 design
**Question:** AWS Nitro Enclave attestations are COSE_Sign1 documents signed by the Nitro hypervisor certificate chain. They are not natively verifiable by EVM contracts (require X.509 certificate chain verification on-chain, which is gas-prohibitive). What is the practical path to making TEE attestation verifiable on Polygon?

**Options:**
- A: Use an off-chain attestation verifier (e.g. Marlin's Oyster Network or DCAP verifier) that provides an on-chain-readable proof of the enclave's code hash.
- B: Use Intel TDX with a ZK proof of the attestation (zkTLS-style), allowing a compact proof to be verified cheaply on-chain.
- C: Register the TEE's code hash in the Vault contract via governance, and have the TEE self-report its code hash alongside each order signature. The Vault checks the code hash matches the registered value. (Weaker: requires trusting governance.)

---

### Q3 — FROST TSS signing latency vs. Polymarket order freshness (Signing Layer v3)

**Status:** DROPPED (2026-05-20)
**Reason:** TSS/FROST has been removed from the Polyshield roadmap. Signing latency from threshold signing ceremonies is incompatible with Polymarket's order freshness requirements and introduces unacceptable complexity. The trust evolution path is: v1 (centralized operator) → v2 (TEE/AWS Nitro). TSS will not be pursued. Q3 is no longer relevant.

---

## ZK Circuit Design

### Q4 — CLOB share ownership proof [BLOCKER for Settlement Credit]

**Status:** RESOLVED (2026-05-20)
**Resolution:** Option B (Vault records shares at authorizeBet time) + FOK orders. See details below.
**Impact:** Settlement Credit circuit design, Vault contract design

**Resolution rationale:**

Polymarket's CLOB is off-chain and does not expose signed order receipts (Option A requires Polymarket cooperation, which is unavailable). Relying on the Signing Layer to self-report shares (Option C) weakens the trust model unacceptably for v1.

Option B is viable because of two confirmed facts from API research:
1. **FOK orders are supported.** A FOK order either fills 100% at the limit price or is fully cancelled. There are no partial fills with FOK. This eliminates the approximation risk between `shares_expected` and `shares_received`.
2. **`price` as a public input is sufficient.** With FOK and a user-specified limit price, `expected_shares = floor(bet_amount / price)` is deterministic and computable on-chain. If the FOK fills, exactly this many shares are purchased (within 1 share of integer rounding due to tick size). If it doesn't fill, `authorizeBet` is never called on-chain.

**Adopted design:**

- Add `price` as a public input to the Bet Authorization circuit.
- Circuit constraint: `expected_shares = floor(bet_amount / price)` (integer arithmetic, in shares units).
- Vault records `(nullifier_hash, market_id, position_id, expected_shares)` on-chain in the `BetAuthorized` event and in storage.
- Signing Layer submits a FOK order at exactly `price`. Only calls `authorizeBet` on-chain after a fill confirmation is received from the CLOB API.
- Settlement Credit proof: `shares_held` is NOT self-reported by the user. It is read from the Vault's own on-chain storage keyed by `nullifier_hash`. The circuit proves ownership of the note whose nullifier matches the stored bet record.
- This is fully trustless: no Polymarket cooperation required, no self-reported values.

**Residual edge case:** If the actual fill price is slightly better than the specified limit price (which can happen with FOK against resting orders at better prices), the actual shares received may slightly exceed `expected_shares`. For v1, this small surplus accrues to the vault's aggregate pUSD pool. A reconciliation mechanism is a v2 enhancement.

**Circuit change required:** Add `price: pub u64` to the Bet Authorization circuit public inputs. See `zk-design.md` — the circuit specification needs updating to reflect this addition.

**Vault contract change required:** `authorizeBet()` must store `(nullifier_hash => BetRecord { market_id, position_id, expected_shares })`. `creditSettlement()` must read `expected_shares` from this storage rather than accepting `shares_held` as a caller-supplied value.

---

### Q5 — Concurrent open positions and partial withdrawal

**Status:** RESOLVED (2026-05-20)
**Resolution:** Option A for v1. Option C targeted for v2.

The v1 design accepts that users must wait for all open positions to settle before withdrawing their full balance. Open positions are not reflected in the current note balance — the user can only withdraw what has been credited via Settlement Credit proofs.

This limitation must be communicated clearly in the frontend: display a breakdown of settled balance (withdrawable) vs. in-flight balance (locked in active positions) so users understand the state of their funds.

**v2 path:** A "Withdrawal with Change" circuit (Option C) will allow partial withdrawal. It spends the current note, transfers `withdrawal_amount`, and creates a new note for `balance - withdrawal_amount`. All active positions must still be settled before the total balance can be accessed, but the user can at least move settled funds without waiting for unrelated markets to resolve.

---

## Economic and Accounting

### Q6 — Bet descriptor on-chain privacy

**Status:** RESOLVED (2026-05-20)
**Resolution:** Option A — bet descriptor remains public. No encryption path planned.

The vault's Polymarket EOA submits each order to the CLOB, where it is immediately visible in Polymarket's order book, on the explorer, and in on-chain CTF state. The `BetAuthorized` event on the Vault contract contains the same parameters (`market_id`, `outcome_side`, `bet_amount`, `price`, `expected_shares`). Encrypting the Vault event would not hide anything from an observer who can already see the EOA's activity on Polymarket — it would add circuit complexity and Signing Layer decryption logic with no meaningful privacy improvement.

The privacy guarantee Polyshield provides is precisely: **which depositor authorized which bet is hidden.** The bet content — market, side, amount — is public by design (via the EOA's Polymarket activity). This is not a gap; it is what the system is. Polyshield is a signer-anonymizer, not a bet-content mixer. An observer knowing "the vault bet 500 USDC YES on market X" cannot attribute that to any specific depositor without breaking the ZK proof.

The real anonymity variable is anonymity set size (T3 in `threat-model.md`): how many depositors could plausibly have placed any bet from the vault at that time. That is the correct privacy lever. T1 in `threat-model.md` has been updated to reflect this correction.

---

### Q7 — Partial CLOB fills

**Status:** RESOLVED (2026-05-20)
**Resolution (v1):** Option C — FOK (Fill-or-Kill) orders exclusively.
**REOPENED 2026-05-30:** as a near-term roadmap item to add native limit orders (GTC/GTD). v1 stays FOK-only. See FC-4 in `docs/future-changes.md` and the detail block at the end of this question.
**Impact:** Bet Authorization circuit, Settlement Credit circuit, Vault accounting, Signing Layer, new partial-fill credit proof

**Resolution rationale:**

FOK order support is confirmed in Polymarket's API documentation. The CLOB has an explicit error code `FOK_ORDER_NOT_FILLED_ERROR` for FOK orders that cannot be fully matched. This means:
- A FOK BUY order for `bet_amount` either fills 100% or is cancelled entirely.
- If it fills: exactly `bet_amount` pUSD is spent, and `expected_shares = floor(bet_amount / price)` outcome tokens are received.
- If it doesn't fill: the Signing Layer does NOT call `authorizeBet` on-chain. The user's note is unchanged.

This eliminates the partial fill accounting problem entirely. No Refund Credit proof type is needed for v1.

**Operational sequence the Signing Layer must follow:**
1. Receive ZK proof and bet params from user via the proof relay.
2. Submit ZK proof to Vault contract for on-chain verification. Wait for 1 block confirmation.
3. Submit FOK order to CLOB API.
4. If FOK fills: Vault `BetAuthorized` state is consistent — done.
5. If `FOK_ORDER_NOT_FILLED_ERROR`: see Q7a below — a recovery proof type is required.

**Sub-question Q7a — RESOLVED (2026-05-20):** Bet Cancellation Credit circuit specified in `zk-design.md` Section 5. Design summary: the Signing Layer operator calls `Vault.reportFOKFailure(nullifier_of_bet)`, which marks the bet record `FAILED`. The user then submits a Bet Cancellation Credit proof proving ownership of the post-bet note. The Vault injects `bet_amount` from `betRecords` (not user-supplied) and verifies the proof before restoring the note balance. The `BetRecord` struct now includes `bet_amount` and `status` fields. Both `bet_cancel.nr` and `cancel_credit.nr` are fully specified and unblocked for Claude Code implementation.

#### REOPENED (2026-05-30): native limit order roadmap

v1 ships FOK-only, which is correct because FOK is all-or-nothing and eliminates partial-fill accounting. But users want true limit orders (rest on the book until filled), so this is reopened as a near-term roadmap item (FC-4). Verified Polymarket facts:

- **Native limit order types** are `GTC` (rests until filled or cancelled) and `GTD` (auto-expires at a timestamp; Polymarket enforces a 60-second security threshold, so an effective lifetime of N seconds means `expiration = now + 60 + N`). Under the hood all orders are limit orders; FOK/FAK are just marketable limit orders. Source: docs.polymarket.com create-order.
- **Fill reporting is available for async orders.** The synchronous `POST /order` response gives `status` (`live`/`matched`/`delayed`/`unmatched`) and FOK failure via `FOK_ORDER_NOT_FILLED_ERROR`. For resting/partial fills, the authenticated **User Channel** websocket (`wss://ws-subscriptions-clob.polymarket.com/ws/user`) pushes `TRADE` messages filtered by API key with lifecycle `MATCHED -> MINED -> CONFIRMED` (and `RETRYING`/`FAILED`). REST `GET /orders/:id` and `GET /trades` allow polling. Source: docs.polymarket.com websocket user-channel.
- **Heartbeat dependency.** Open orders are auto-cancelled if the CLOB heartbeat lapses past 10 seconds. A resting limit order therefore only persists while the signing layer is alive; a signer outage cancels it. This interacts with Q3 (backend availability).
- **Partial fills return.** GTC/GTD/FAK can fill partially, which is exactly what FOK was chosen to avoid. Supporting limit orders requires partial-fill/expiry note accounting: a new operator report `reportPartialFill(nullifier_of_bet, filled_shares, spent_amount)` plus a partial-credit proof that refunds the unfilled remainder to the note.
- **Circuit fit.** `bet_auth` already carries `price` and `expected_shares = floor(bet_amount * 1e8 / price)`, so a user limit price fits the existing circuit. The work is async fill tracking, partial-credit accounting, and the bet-flow ordering decision.

**Two flow options to evaluate in FC-4:**
- A. Place-first, debit-on-fill: submit the GTC/GTD order, then call `authorizeBet` only on confirmed fill. Cleanest accounting (no refund path), but the note balance must be reserved off-chain while the order rests to prevent the user double-spending the same note elsewhere, and the privacy timing model changes (the order rests before any on-chain event).
- B. Pre-debit, refund-remainder: keep the current debit-then-submit pattern; on partial fill or expiry, refund the unfilled portion via the partial-credit proof. Matches today's FOK flow and the cancellation-credit pattern, at the cost of a new proof type and operator report.

Full spec and decision tracked in FC-4.

---

### Q8 — N/A (cancelled market) resolutions

**Status:** RESOLVED (2026-05-20)
**Resolution:** Option A — separate `cancel_credit.nr` circuit type.

A distinct Cancellation Credit proof type handles N/A resolutions. The proof verifies that the market's CTF condition resolved with all-zero `payoutNumerators` (the on-chain fingerprint of an N/A resolution), then credits `total_credit = bet_amount` back to the user's note. The structure mirrors the Settlement Credit circuit: the Vault reads `expected_shares` and `bet_amount` from `betRecords[nullifier_of_bet]` and the circuit verifies the note transition.

Keeping Settlement Credit and Cancellation Credit as separate circuits avoids flag-based branching inside a single circuit, which reduces constraint complexity and simplifies auditing. The circuit specification for `cancel_credit.nr` is complete — see `zk-design.md` Section 6.

---

### Q9 — Per-depositor position caps

**Status:** RESOLVED (2026-05-20)
**Resolution:** Per-address deposit cap of $50,000 USDC for MVP. No cap in v2+.

Since deposits are already public by design (depositor address is visible on-chain), the Vault can enforce a cumulative deposit limit per address without any privacy cost. Implementation: `mapping(address => uint256) public cumulativeDeposits` in `Vault.sol`. The `deposit()` function asserts `cumulativeDeposits[msg.sender] + amount <= 50_000 * 1e6` before accepting the deposit.

No ZK circuit changes required. The cap is enforced entirely at the contract layer.

This prevents any single depositor from monopolizing the vault's Polymarket balance during the MVP period. The cap is removed in v2 once the protocol has demonstrated stability and the anonymity set is large enough that concentration risk is manageable via market forces.

---

## Operational

### Q10 — Note loss recovery

**Status:** RESOLVED (2026-05-20)
**Resolution:** Option A — ECIES encryption with the depositor's wallet key. **Superseded for P3+ by wallet-derived secrets (FC-5/FC-13):** new notes are reconstructible from chain + a single wallet signature, so no ECIES note backup is needed. This ECIES path survives only as an optional fallback for any residual P1/P2 random-secret notes. (Note: the FC-13 *encrypted IndexedDB cache* is a separate mechanism — it protects the performance cache at rest, not a recovery backup.)

The note `(secret, balance, nonce)` is encrypted client-side using ECIES with the depositor's secp256k1 public key (derived from their connected wallet). The ciphertext is stored in two places: browser localStorage (for immediate recovery) and IPFS (pinned by the Proof Relay as a free service, for cross-device recovery).

To recover, the user connects their original wallet and decrypts the ciphertext. No third party learns the note contents. The privacy cost is bounded: the deposit already links the wallet address to the vault, so linking the backup ciphertext to that same wallet does not add a new privacy surface.

**Implementation notes for the SDK:**
- Use `eth_getEncryptionPublicKey` (MetaMask) or equivalent to retrieve the wallet's public key for ECIES.
- Encryption: `ECIES-secp256k1` with `AES-256-GCM` for the symmetric layer.
- The frontend must offer the backup step immediately after note generation, before the deposit transaction is submitted. If the user refuses the backup, display a prominent warning that note loss is permanent and irrecoverable.

---

### Q11 — Deposit Wallet architecture and vault EOA interaction

**Status:** Substantially resolved (2026-05-20). Remaining item: on-chain `redeemPositions` call testing.
**Impact:** Signing Layer implementation, Indexer implementation

**What is now known:**

Polymarket no longer recommends the "Proxy Wallet" (POLY_PROXY, signatureType 1) for new API integrations. The current architecture uses a **Deposit Wallet** (ERC-1967 proxy, signatureType 3 / POLY_1271).

- The Deposit Wallet holds pUSD and CTF outcome tokens (ERC-1155) on-chain.
- The vault's signing EOA is the Deposit Wallet's owner.
- Share balances are held at the Deposit Wallet address in the CTF ERC-1155 contract: `CTF.balanceOf(depositWalletAddress, positionId)`.
- The Deposit Wallet address is deterministic from the owner EOA via CREATE2. Factory: `0x00000000000Fb5C9ADea0298D729A0CB3823Cc07`.
- `payout_per_share` is computed from `CTF.payoutNumerators(conditionId)` and `CTF.payoutDenominator(conditionId)` — confirmed from on-chain CTF state, no external oracle needed.
- After market resolution, the Signing Layer submits a `WALLET` batch to the relayer calling `CTF.redeemPositions(pUSD, bytes32(0), conditionId, indexSets)` from the Deposit Wallet.

**Remaining research task:**
- Confirm the exact `indexSets` parameter encoding for binary (YES/NO) CTF markets.
- Test `CTF.redeemPositions` from a Deposit Wallet on Amoy testnet or a forked mainnet before implementing the Indexer.

**Note on legacy Proxy Wallet:** The vault does NOT need to interact with the legacy Proxy Wallet (`0xaB45c5A4B0c941a2F231C04C3f49182e1A254052`). The Deposit Wallet architecture completely replaces it for Polyshield's use case.

---

### Q12 — Vault EOA ban recovery

**Status:** RESOLVED (2026-05-20)
**Resolution:** Option C for MVP. Option A targeted for v2.

For MVP, accept the ban risk. If Polymarket bans the vault's EOA, new bet authorization is paused. Withdrawals and settlement credits are unaffected — users retain full access to their funds. The circuit breaker in the Signing Layer (dead-man halt on 403 / account-flagged API response) is the primary operational response. The operator deploys a new vault instance with a new EOA.

**v2 path:** Option A — the Vault contract maintains a `mapping(address => bool) public authorizedSigners` and a `activeSignerEOA` pointer. A governance transaction (or operator multisig) can register a new EOA and point `activeSignerEOA` to it. The Vault's `authorizeBet` function emits the new signer's address in the `BetAuthorized` event so the Signing Layer knows which EOA to route through. USDC custody and all commitments remain in the same Vault contract across EOA rotations.

---

## New Questions Identified During API Research (2026-05-20)

---

### Q13 — pUSD vs USDC: Vault collateral asset [BLOCKER for Vault.sol]

**Status:** RESOLVED (2026-05-20)
**Resolution:** Option A — Vault accepts USDC, converts to pUSD internally.

pUSD is an internal implementation detail of the Polymarket integration. From the user's perspective, the vault is USDC-denominated throughout. Deposits, withdrawals, and all ZK circuit arithmetic use USDC micro-units (6 decimals). The conversion is encapsulated in two internal Vault functions:

- `_fundDepositWallet(uint256 amount)` — converts USDC to pUSD via `CollateralOnramp` (`0x93070a847efEf7F70739046A929D47a521F5B8ee`) and transfers to the Deposit Wallet.
- `_returnFundsFromDepositWallet(uint256 amount)` — converts pUSD back to USDC via `CollateralOfframp` (`0x2957922Eb93268531d39fAcCA3B4dC5854`) and receives into the Vault.

The conversion rate is 1:1 (pUSD is pegged to USDC). ZK circuits do not need to know about pUSD at all.

**Deployment timing (2026-06-01):** *when* USDC is converted and sent to the Deposit Wallet is governed by the collateral-deployment strategy. **Option 3 (JIT) is implemented (FC-7):** the signing layer calls `Vault.fundPolymarketWallet(shortfall)` per bet, just before submitting the order, converting only the uncovered remainder. The conversion now runs as a relayer WALLET batch against the deposit-wallet proxy (`DepositWalletExecutor`), not the spec-only `_fundDepositWallet`/`_returnFundsFromDepositWallet` helpers above. See `collateral-deployment-strategy-comparison.md`.

---

### Q26 — Transition from JIT (Option 3) to base buffer + JIT overflow (Option 4)

**Status:** Open (direction agreed: Option 4 is the successor)
**Impact:** Collateral deployment policy, buffer-manager service, `deploymentCap` sizing
**Question:** Option 3 (JIT) is live and already accretes a residual buffer (no sweep-back on no-fill). Moving to Option 4 means proactively managing that buffer (low/high-water top-ups in bulk, bleed-down during incidents) rather than relying on per-bet accretion. When do we cut over, what are the low/high-water marks and the target buffer as a fraction of TVL, and is the fenced deposit-wallet owner a prerequisite for raising the standing balance? See FC-6 (buffer policy) and FC-7 (JIT) in `future-changes.md`.

---

### Q14 — L2 API key management in the Signing Layer

**Status:** Open
**Impact:** Signing Layer v1, v2, and v3 design
**Question:** Polymarket's CLOB API requires L2 HMAC-SHA256 authentication headers on every trading request (order submission, cancellation, heartbeat). L2 credentials (key, secret, passphrase) are derived from L1 (private key) authentication and are distinct from the order signing key. How are these credentials managed, stored, and rotated in the Signing Layer?

**Specific sub-questions:**
- L2 credentials are derived deterministically from the signing key and a nonce. If the nonce is lost, new credentials must be created (old nonce cannot be recovered). Where is the nonce stored?
- In v2 (TEE), L2 credentials must live inside the enclave alongside the signing key. How are they initialized (does the enclave perform L1 auth on first boot to derive credentials)?
- What is the rotation strategy if L2 credentials are compromised? A new nonce creates new credentials, but does Polymarket invalidate the old ones automatically?
- Rate limits: the CLOB API has rate limits (documented at `/api-reference/rate-limits`). If the vault submits many users' bets in a short window, could rate limiting prevent timely order submission? This needs to be tested at the expected throughput.

**Current best thinking:** For v1, store L2 credentials in environment variables alongside the signing key. Derive them on first deployment using L1 auth with nonce 0. Document the nonce. For v2, the TEE performs L1 auth on first boot and derives/stores credentials inside the enclave. Rotation is triggered by the operator via a governance transaction that causes the TEE to re-derive credentials with a new nonce.

---

### Q15 — CTF Exchange V2 EIP-712 domain and order struct compatibility



**Status:** Open — research needed before implementing the Signing Layer
**Impact:** Signing Layer implementation
**Question:** The deployed CTF Exchange V2 (`0xE111180000d2663C0091e4f400237545B87B996B`) uses a new order struct and EIP-712 domain vs V1. The POLY_1271 signature wraps the order in an ERC-7739 `TypedDataSign` payload. What is the exact EIP-712 type hash for the V2 order struct? Does V2 change any field names or types vs V1?

**Research needed:**
- Inspect the CTF Exchange V2 source at `github.com/Polymarket/ctf-exchange-v2`.
- Confirm the `Order` struct field names and types used for EIP-712 hashing.
- Confirm the EIP-712 domain for V2 (name, version, chainId, verifyingContract).
- Use the official SDK (`@polymarket/clob-client-v2`) to avoid reimplementing the signing logic manually — the SDK handles V2 struct hashing and ERC-7739 wrapping.

---

## Design-Surfaced Future Features (added 2026-05-21)

These items emerged from the Claude Design prototype. They are not blockers for the v1 implementation but need research and design decisions before they can be built. Add specs to the relevant docs when ready to implement.

---

### Q16 — Decoy traffic system

**Status:** Open — requires research and specification
**Impact:** Proof Relay, Privacy Metrics, SDK
**Source:** Design prototype (Roadmap P2, DepositFlow completion screen "Set up decoy traffic", PrivacyMetrics "Decoy density: 12.3%")

**Question:** How should the decoy traffic system work? The design implies that some fraction of vault activity is fake proofs emitted to obfuscate the timing correlation between a user's deposit and their bet authorizations. Who generates the decoys? Who pays for them? What is the right decoy density?

**Options to evaluate:**
- A: Protocol-funded decoys — the Vault contract operator funds a pool of dummy wallets that generate genuine commitment/nullifier pairs on a schedule. Real proofs but from empty notes.
- B: User-optional decoys — the SDK can generate self-funded dummy transactions on behalf of the user (user pays gas, gets better timing entropy).
- C: Coordinator-generated decoys — the Proof Relay generates synthetic Merkle path proofs that don't correspond to any real note (requires a circuit change to allow zero-balance proofs as decoys).

**Open questions:**
- Can decoys be fully indistinguishable from real bet authorizations without having a real funded note? If not, Option C is invalid.
- What decoy density is sufficient? The design shows 12.3% — is this analytically motivated?
- Does the Vault contract need changes to accept decoy proofs, or are decoys entirely at the relay/relay-network layer?
- Timing: decoys should fire with randomized jitter in the same time window as real bets. What's the right jitter distribution?

---

### Q17 — Onion-routed proof relay (3-hop)

**Status:** Open — significant implementation work
**Impact:** Proof Relay architecture, Privacy Metrics
**Source:** Design prototype (WithdrawFlow Step 2 shows 3 relay hops: us-east, eu-west, ap with per-hop timing; PrivacyMetrics shows "Relay hops: 3 randomized")

**Question:** The current proof relay is a single-hop stateless forwarder. The design implies a 3-hop onion routing scheme where the proof is layered-encrypted to each relay node's public key and each hop adds timing jitter before forwarding. Is this the right architecture? What are the privacy tradeoffs vs the single-hop relay?

**Design intent (from prototype):**
- 3 relay nodes: us-east, eu-west, ap (geographic diversity)
- Per-hop latency: ~140–300ms natural + configurable jitter
- "Standard" posture: 3–12 min total delay
- "Fast" posture: 30–90 s (reduced entropy)
- "Paranoid" posture: 15–60 min (maximum timing entropy)
- Proof is encrypted to each hop's public key (onion layers)

**Questions to resolve:**
- Is onion routing actually necessary for the withdrawal privacy guarantee, or does the ZK proof itself provide sufficient unlinkability? (The recipient address is already committed in the proof; timing is the only remaining leak.)
- If implemented, how are relay node public keys managed and rotated?
- Can a single-operator relay with synthetic delay achieve the same entropy as a multi-party onion route?
- What threat model does 3-hop routing defend against? (The circuit breaker in the Signing Layer defends against a compromised relay learning the source IP, but 3 hops is only valuable if they are operated by independent parties.)

---

### Q18 — Withdrawal timing posture (Standard/Fast/Paranoid)

**Status:** Open — UX and backend design needed
**Impact:** SDK, Proof Relay, frontend
**Source:** Design prototype (WithdrawFlow step 0 delay posture selector, WithdrawFlow step 2)

**Question:** The design exposes three withdrawal delay modes to the user. How are these implemented in the relay? Is the delay enforced at the relay (so the user must trust the relay to apply it), or is the delay built into the proof itself?

**Design buckets:**
- Standard: 3–12 min total relay delay
- Fast: 30–90 s (user accepts lower timing entropy)
- Paranoid: 15–60 min (maximum timing entropy, very low deanonymization risk)

**Questions to resolve:**
- Who enforces the delay — the relay, the user's client, or the Vault contract?
- If enforced by the relay, the relay learns the user's posture preference (minor metadata leak). Is this acceptable?
- Can the delay be committed in the proof (e.g., proof includes a timestamp lower bound), so the Vault contract enforces minimum delay on-chain? This would be trust-minimized but adds circuit complexity.
- What is the right UX default? "Standard" seems correct — "Fast" should require explicit acknowledgment that timing entropy is reduced.

---

### Q19 — Privacy metrics computation (unlinkability score, timing entropy, K-anonymity)

**Status:** Open — requires cryptographic research and metric definitions
**Impact:** Privacy Metrics page, SDK, backend
**Source:** Design prototype (PrivacyMetrics page shows: anonymity set size, timing correlation risk score, vault activity heatmap, decoy density, withdrawal unlinkability 99.8%, timing entropy 7.4 bits)

**Question:** How are the privacy metrics displayed in the UI actually computed? Some of these (anonymity set size) are straightforward; others (timing entropy, unlinkability score) require cryptographic or statistical definitions.

**Metrics to define:**
- **Anonymity set size**: Number of wallets with at least one unspent commitment in the Merkle tree. Straightforward — count leaves minus nullified commitments.
- **Timing entropy (bits)**: Shannon entropy of the observed fill-time distribution over the anonymity set window. Needs a formal definition of "window" and "observation resolution."
- **Decoy density**: Fraction of vault fills that are decoys. Straightforward once decoy system is designed (Q16).
- **Unlinkability score (0–100%)**: `1 - 1/k` where `k` is anonymity set size? Or more sophisticated (incorporating timing, decoy, and chain-analysis resistance)? Needs a formal definition.
- **K-anonymity score**: Minimum k such that any adversary cannot distinguish the user's fills from at least k-1 others. Needs a formal definition.
- **Timing correlation risk**: Probability that a passive observer can link a deposit to a fill using timing alone. Requires modeling of the timing jitter distribution.

**Questions to resolve:**
- Are these metrics computed by the frontend client (from on-chain state) or by a backend analytics service?
- Should the metrics be published on-chain (e.g., snapshotted in the Vault contract) or are they entirely off-chain informational?
- Who is responsible for defining the formal metric specifications? This likely requires a cryptographer.

---

### Q20 — Sparse Merkle Tree (SMT) for nullifier set

**Status:** RESOLVED (2026-05-31)
**Resolution:** Keep the `mapping(bytes32 => bool)` nullifier registry. No SMT for v1 or v2.
**Impact:** NullifierRegistry.sol, ZK circuits (nullifier membership proofs)
**Source:** Design prototype (Docs page shows `nullifierRoot: bytes32 // SMT root over spent nullifiers`)

**Resolution rationale:** None of the eight active circuits (bet_auth, settlement_credit, withdrawal, bet_cancel, cancel_credit, deposit, position_close, partial_credit) proves nullifier *non-membership* inside a proof. Each proves note ownership plus correct nullifier *derivation*; the "already spent?" check is performed on-chain by the contract reading the registry, exactly the Tornado/Zcash split. The contract is the authority, so a mapping is sufficient. Two further points reinforce this: (1) gas: an SMT insert is O(log n) Poseidon hashes on-chain added to every state transition (authorizeBet/withdraw/credit), versus a single SSTORE for the mapping, a recurring cost for zero v1 benefit; (2) the prototype's `nullifierRoot` and `marketRoot` are speculative UI-doc fields, not derived requirements, and `marketRoot` in particular is redundant because `ctf.payoutNumerators`/`payoutDenominator` is already the on-chain authority that `resolveMarket` reads.

**Single reopen trigger:** a future batch/aggregated proof circuit that verifies many nullifiers in one off-chain proof with no per-nullifier on-chain check (or an L3/stateless redesign). Neither is on the roadmap. If such a circuit is ever specified, revisit with an SMT at that time.

**Question:** The current NullifierRegistry is a simple `mapping(bytes32 => bool)`. The design prototype's documentation page shows a `nullifierRoot` in the VaultState struct, implying a Sparse Merkle Tree. Does the protocol need a SMT for nullifiers, or is the mapping sufficient?

**Analysis:**
- **Mapping (current plan):** O(1) insert, O(1) lookup. Non-membership proof impossible on-chain (the circuit cannot prove a nullifier is NOT spent without the registry returning false). Suitable for v1 where the circuit does not need to prove non-membership.
- **SMT:** O(log n) insert and lookup. Non-membership proofs possible. Required if any circuit needs to prove "this nullifier does not exist in the set" as a ZK constraint. Adds complexity to NullifierRegistry.sol and requires a SMT Solidity library.

**Questions to resolve:**
- Do any of the five circuits need to prove nullifier non-membership inside a ZK proof? If not, the mapping is sufficient and the SMT is unnecessary complexity.
- If future circuits need non-membership proofs (e.g., a batch withdrawal circuit), is it acceptable to add a SMT in a v2 upgrade?
- The `marketRoot` field in the design's VaultState (root of resolved markets) suggests a similar pattern — is a Merkle accumulator of resolved markets needed on-chain, or is the CTF contract's state sufficient?

---

### Q21 — WebSocket feed for live vault data

**Status:** Open — backend design needed
**Impact:** Backend, frontend
**Source:** Design prototype (Docs page SDK/API section lists "WebSocket feed" as an endpoint)

**Question:** The design implies a WebSocket feed for live vault data (vault activity, fills, proof status). The backend currently has only a REST API (`GET /settlement/:market_id`). What data should the WebSocket feed emit, and which service owns it?

**Candidate events to stream:**
- New `BetAuthorized` events from the Vault contract
- Fill confirmations from the CLOB
- Settlement resolutions from the CTF
- Proof relay status updates (submitted, confirmed, relayed)
- Anonymity set size changes (new deposits/withdrawals)

**Questions to resolve:**
- Is the WebSocket feed public (any observer can subscribe) or authenticated (per-wallet subscriptions for the user's own proof status)?
- Which backend service owns the WebSocket — the Indexer, the Proof Relay, or a dedicated streaming service?
- Should this be a standard WebSocket or use SSE (Server-Sent Events) for the client?

---

### Q22 — Testnet invite and waitlist system

**Status:** Open — infrastructure design needed (not blocking v1 protocol)
**Impact:** Frontend, backend (new service or external tool)
**Source:** Design prototype (TestnetPage with seat counter, invite codes, profession selector)

**Question:** The design includes a testnet waitlist with invite codes, seat counter (e.g., "1,842 / 2,000"), profession selector, and email + X/Twitter fields. Is this a custom backend service or an external tool (Notion, Typeform, Airtable)?

**Questions to resolve:**
- Should invite codes be cryptographically verified on-chain, or just database-checked off-chain?
- Who reviews applications and grants access?
- If seat-gated, what is the gate enforcement mechanism (contract allowlist, backend JWT, or just an honor system)?

---

### Q23 — Encrypted note backup file format

**Status:** RESOLVED (2026-05-31)
**Resolution:** Obviated by wallet-derived secrets. No encrypted note backup file is required.
**Impact:** SDK, frontend
**Source:** Design prototype (DepositStep3 "Download encrypted backup", "Export encrypted backup" buttons)

**Resolution rationale:** Secrets are now wallet-derived deterministically (FC-5, and FC-13 which replaced the per-index scheme with a one-signature master seed). A wallet with zero local state reconstructs every note (balances, open positions, deposits, withdrawals, P&L) from on-chain events plus a single wallet signature via `recoverNotes()` (`frontend/src/lib/notes.ts`). The wallet *is* the backup, so there is no per-deposit random secret to preserve and therefore no backup-file format to specify. The note cache holds no secret; under FC-13 it is persisted **encrypted in IndexedDB** (a performance convenience, never a source of truth) and rebuilt by `recoverNotes` if wiped. The deposit-index counter is likewise recoverable by scanning `Deposited(W, ...)` events.

**Note (FC-13):** the encrypted IndexedDB note cache is distinct from the Q10 ECIES backup. The IDB encryption protects the *performance cache* at rest (non-extractable AES-GCM key, no signature to read); it is not a recovery backup (recovery is from chain + wallet). The Q10 ECIES backup remains relevant *only* for residual P1/P2 random-secret notes.

**Downstream reconciliation (applied via FC-13):** with wallet-derived secrets as the model, the P1/P2 random-secret + ECIES-backup path is legacy. T12 (note grinding) and T17 (note preimage loss) are updated to the wallet-derived/FC-13 model; Q10 (note loss recovery via ECIES) survives only as an optional fallback for any residual P1/P2 notes. See FC-13.

**Original open question (now moot):** Q10 had resolved that notes should be backed up via ECIES with the user's wallet key; the file format was left unspecified. Wallet-derived secrets remove the need entirely.

---

## Position Management (added 2026-05-30)

### Q24: Position close / secondary sale before settlement

**Status:** RESOLVED (2026-05-30)
**Resolution:** New `position_close` proof type, mirror of Settlement Credit. v1 = operator-reported proceeds. Partial sells supported in v1.
**Impact:** New circuit, new Vault function, Signing Layer, `BetRecord` struct
**See also:** `docs/future-changes.md` FC-1 (implementation plan), T20.

**Problem:** A depositor cannot exit a position before the market resolves. A bet is a FOK BUY; value only returns to the note via Settlement Credit, Bet Cancellation Credit (FOK failed), or N/A Cancellation Credit. Active traders need to realize gains or cut losses mid-market. This is the active-management side of the Q5 limitation.

**Resolution rationale:**

Closing means the Signing Layer submits a FOK SELL of the user's shares of `position_id` at a user-chosen limit price. Proceeds (pUSD then USDC via offramp) return to the pool, and the user's note is credited. The note mechanics mirror `settlement_credit` exactly: spend the post-bet note, prove tree membership, recommit `balance + proceeds`.

The mid-market sell price is set by the off-chain CLOB fill and is NOT derivable from CTF on-chain state, so `proceeds` cannot be made trustless the way `payout_per_share` is. The chosen v1 design sources `proceeds` from an operator report (operator-only `reportSold`, mirror of `reportFilled`), Vault-injected so the user cannot alter it in the proof. This is the same trust class already accepted by `acknowledgePolymarketReturn`. v2 moves to an on-chain `OrderFilled` event proof or a TEE-attested value.

**v1 scope:**
- Full and partial sells are both supported in v1. A partial sell splits one bet record into a sold portion (credited) and a remaining portion (still `FILLED` against fewer shares); the remainder reuses the change-note construction already present in `withdrawal.nr`.
- Proceeds are operator-reported and Vault-injected.

**Privacy:** A SELL from the vault EOA is publicly visible on Polymarket, exactly like the BUY, consistent with the public-bet-content model (Q6/T1). The close proof reveals `nullifier_of_bet`, but Settlement Credit already reveals the same value, so no new linkage is created. Close requests go through the relay, never the user's wallet (T19).

**Sign-off note:** New circuit, new public inputs, new bet statuses, and a new operator trust instance. Approved in direction; confirm exact public-input ordering against the verifier before codegen. See FC-1.

---

## Compliance (added 2026-05-30)

### Q25: Compliant selective disclosure of a depositor's bets

**Status:** ONGOING
**Direction:** Option C, threshold-escrowed, per-subject viewing key.
**Impact:** SDK, deposit flow, key-management infrastructure, governance

**Problem:** A regulator may lawfully request the full bet history of an identified depositor W (for example, to detect or track insider trading). The privacy invariant hides which depositor authorized which bet. The compliance goal is selective, per-subject disclosure with no protocol-wide backdoor: producing W's bets must not deanonymize any other depositor.

**Why this is feasible at all:** Three structural facts give a per-subject hook. (1) `owner_address` (= W) is in every note commitment via `Poseidon4(secret, balance, nonce, owner_address)`. (2) In P3+, secrets are wallet-derived deterministically by deposit index, so given W's wallet (or a key derived from it) every note in W's lineage is re-derivable. (3) The deposit W → vault is already public. Together, anyone holding W's viewing key can re-derive W's secrets, recompute every commitment/nullifier in W's chain, and match them to the public `BetAuthorized` events. No one else can. That is a Zcash-style viewing key.

**Chosen direction, Option C (threshold-escrowed viewing key):** At deposit, the client additionally submits `ThresholdEnc(guardians, viewing_key_for_W)`, keyed to W. A lawful request triggers a k-of-n guardian decryption that yields only W's viewing key, after which disclosure proceeds as with a user-held key. This is per-subject (never exposes the whole set), auditable (each decryption is a recorded guardian action), and does not require subject cooperation, which jurisdictions that mandate a recoverable disclosure path generally require.

**Open items (why this is ONGOING, not resolved):**
- Guardian set composition, threshold parameters (k, n), and selection/rotation governance.
- Encryption scheme for the escrow blob and its binding to W and to the deposit.
- Whether Option C is mandatory for all deposits or gated per deployment/jurisdiction; the privacy trade-off (a k-of-n quorum that can deanonymize a chosen subject) must be explicitly accepted by Arya before this ships.
- Interaction with P1/P2 random secrets (viewing key is the note backup set, not auto-derivable) vs P3+ deterministic secrets (clean).
- Relationship to the existing auto-settlement permission blob, which already gives the operator linkage for opt-in users and could serve as an interim disclosure source.

**Options considered and not chosen as the primary path:**
- User-held viewing key (compelled disclosure only): zero backdoor, but cannot satisfy jurisdictions requiring disclosure without subject cooperation. Strong default candidate; retained as the disclosure mechanic that Option C feeds into.
- Owner reveal at settlement: destroys the core invariant for everyone; rejected as a default.
- Privacy-Pools association sets: answers "is W clean?", not "what did W bet?"; adjacent tool, different question.

**Decision required from Arya:** confirm Option C parameters and whether it is mandatory or deployment-gated. This is a privacy-model change and requires explicit trade-off acceptance.

---

## Threat-Derived Questions (added 2026-05-31)

These questions formalize the design of threats that were tracked only in `threat-model.md` and had no home in this tracker. Closing the gap between the two documents.

---

### Q26: Signing-layer front-running mitigation (v1)

**Status:** RESOLVED (2026-05-31)
**Resolution:** Accept the information-leak residual in v1 under operational policy; rely on v2 TEE for the cryptographic fix. Commit-reveal rejected. Driver: T4.
**Impact:** Signing Layer v1, threat-model T4

**Resolution rationale:** Split T4 into two sub-risks. (1) **Degraded-fill front-running is already capped by design** (Q4/Q7): bets are FOK at a user-set limit price, so if the operator trades ahead and moves the price, the user's FOK fails (`FOK_ORDER_NOT_FILLED_ERROR`) and the bet_amount is reclaimed via Bet Cancellation Credit. The operator can never make the user overpay or fill worse than their limit. (2) **The residual is information leakage / copy-trading:** the operator must read the plaintext bet to construct and sign the order, so it learns the user's directional view and can trade it on a side account. Commit-reveal does NOT address this, because it defends only against third parties racing a revealed mempool tx, not against the executor, which reads plaintext at execution time; you cannot have the operator sign an order it cannot read. So commit-reveal is dropped (it adds latency and a transaction for no benefit).

**v1 acceptance (Arya, 2026-05-31):** the operator is project-run, under a documented policy of no proprietary trading on vault markets. T4 reassessed CRITICAL → MEDIUM for v1. The residual is eliminated cryptographically in v2 when the TEE sees bet parameters only inside the enclave. v3/threshold signing remains dropped (Q3).

---

### Q27: Circuit/verifier upgrade and revocation model

**Status:** RESOLVED at design level (2026-05-31)
**Resolution:** Versioned verifier registry with enable/disable + emergency pause; note format stays frozen; correct the prior "redeemable against creation-time verifier" guidance. Driver: T11.
**Impact:** `Vault.sol` verifier registry, circuit upgrade process, threat-model T11

**Resolution rationale:** The note `Poseidon4(secret, balance, nonce, owner_address)` is a frozen protocol constant and commitments are bare hashes in the tree, not bound to any circuit; only *proofs* bind to a verifier. Three upgrade cases must be handled differently, and the previous "always redeemable against the verifier it was created under" guidance is wrong for the common case:

- **Soundness bug, public inputs unchanged (common):** REVOKE the buggy verifier and deploy a fixed one with identical public inputs. Because the note format is frozen, it spends the exact same existing notes, so nothing is lost. Keeping the old verifier live (the prior guidance) is the actual exploit window.
- **Public-input change (e.g. Q4 adding `price`):** treat as a new circuit version; the contract may accept both across a transition window; notes are unaffected because the format did not change.
- **Note-format change:** the only case that truly invalidates commitments; forbidden without sign-off; if ever forced, use leaf-level version tags + a dual-tree migration with old notes still spendable via the old (sound) circuit.

**Adopted design:** a `mapping(circuitId => mapping(version => address))` verifier registry + an active-version pointer + a per-verifier enable/disable flag + an emergency pause that can halt a specific verifier the instant unsoundness is found. The emergency pause is a deliberate centralization trade-off, accepted because a circuit bug is a fund-loss event. Keep Poseidon4 frozen so circuit fixes never touch commitments.
