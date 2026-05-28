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
**Resolution:** Option C — FOK (Fill-or-Kill) orders exclusively.
**Impact:** Bet Authorization circuit, Settlement Credit circuit, Vault accounting

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
**Resolution:** Option A — ECIES encryption with the depositor's wallet key.

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

**Status:** Open — design decision needed before NullifierRegistry v2
**Impact:** NullifierRegistry.sol, ZK circuits (nullifier membership proofs)
**Source:** Design prototype (Docs page shows `nullifierRoot: bytes32 // SMT root over spent nullifiers`)

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

**Status:** Open — SDK design needed
**Impact:** SDK, frontend
**Source:** Design prototype (DepositStep3 "Download encrypted backup", "Export encrypted backup" buttons)

**Question:** Q10 resolved that notes should be backed up via ECIES with the user's wallet key. But the backup file format is unspecified. What is the structure of the exported backup file?

**Questions to resolve:**
- File format: JSON (human-readable), binary, or base64-encoded ciphertext?
- What metadata is included alongside the ciphertext (version, vault address, deposit block number, note index in Merkle tree)?
- Can multiple notes be exported in one file?
- How does the import flow work: connect wallet → decrypt file → restore notes to local state?
- Should the backup also be pinnable to IPFS (as Q10 mentions) automatically, or only if the user opts in?
