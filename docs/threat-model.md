# Threat Model: Polyshield

**Version:** 0.1 (Design Phase)
**Format:** Each vector has a severity rating, description, and mitigation status.

Severity: CRITICAL (breaks privacy or causes fund loss) / HIGH (significant risk) / MEDIUM / LOW

---

## 1. On-Chain Privacy Attacks

### T1 — Bet Descriptor Visibility (Not a Deanonymization Vector)
**Severity:** LOW (reassessed)
**Description:** The `BetAuthorized` event makes `(market_id, outcome_side, bet_amount, price, expected_shares)` public on-chain. An observer can see the vault's full betting activity. However, this is not a meaningful deanonymization vector: the vault's Polymarket EOA already submits every order to the CLOB publicly, where it is visible in Polymarket's order book, the explorer, and the on-chain CTF state. The Vault event contains no additional information beyond what is already public via the EOA's Polymarket activity.

Polyshield's privacy guarantee is: **which depositor authorized which bet is hidden.** Bet content (market, side, amount) is publicly visible by design, through the vault EOA's Polymarket activity. An observer who knows "the vault bet 500 USDC YES on market X" still cannot attribute that to any specific depositor without breaking the ZK proof. The genuine privacy variable is anonymity set size (see T3).

**Mitigation:** None needed. Bet descriptor encryption (previously considered in Q6) was evaluated and rejected as adding circuit and Signing Layer complexity with no meaningful privacy improvement.
**Status:** CLOSED (Q6 resolved as Option A — public descriptor, no encryption)

### T2 — Merkle Tree Leaf Timing Correlation
**Severity:** MEDIUM
**Description:** The Commitment Merkle Tree is append-only and publicly ordered. If User A deposits (leaf N) and immediately submits a Bet Authorization proof (creating leaf N+1), a timing-aware observer can infer that the same entity created both leaves. The bet authorization does not reveal the depositor's address, but the sequential timing creates a correlation.
**Mitigation:** Insert decoy leaves (zero-value commitments) between real operations. Apply randomized time delays (5-30 minutes) before executing bet authorizations after deposit. Document this as a recommended user practice.
**Status:** PARTIAL (decoy leaf mechanism not yet designed)

### T3 — Anonymity Set Size at Launch
**Severity:** HIGH
**Description:** If only 5-10 depositors use the vault at launch, any bet from the vault's EOA is attributable to one of a small number of candidates. The privacy guarantee is proportional to the anonymity set size (number of active depositors with funds in the vault).
**Mitigation:** Minimum viable anonymity set must be defined. Do not advertise the product publicly until a sufficient base of depositors is established. Consider seed depositors (protocol treasury or early users) to bootstrap the anonymity set.
**Status:** OPEN (minimum set size not defined)

---

## 2. Signing Layer Attacks

### T4 — Signing Layer Front-Running (v1 Critical)
**Severity:** CRITICAL (for v1)
**Description:** In v1, the centralized signing operator receives bet parameters before executing the Polymarket order. The operator can read the bet (market, side, amount) and place their own order first, then execute the user's order, profiting from the price impact of the user's bet.
**Mitigation (v1):** Implement a commit-reveal scheme: the user publishes a commitment to the bet parameters on-chain first (a hash of the plaintext bet descriptor). After N blocks, the plaintext parameters are revealed and the operator executes. This makes front-running futile (the price has already moved after the commit).
  - Risk: this adds latency (block time * N, approximately 2-6 seconds on Polygon) and an additional transaction.
  - Alternative: accept front-running risk in v1 prototype (not acceptable for production).
**Status:** OPEN (commit-reveal mechanism not yet designed)
**Note:** This attack is eliminated in v2 (TEE sees parameters only inside the enclave) and v3 (threshold signers see parameters but cannot individually act on them without threshold cooperation).

### T5 — Signing Layer Censorship
**Severity:** HIGH (for v1)
**Description:** In v1, the operator can refuse to execute specific bets (censorship) or execute them selectively. A censored user's funds remain safe (they can withdraw), but they cannot place bets.
**Mitigation:** In v1, document the censorship risk. In v2, the TEE's code is public and auditable; the enclave is programmatically required to execute all valid proofs. In v3, threshold signers must collectively agree to censor, which requires coordination among N parties.
**Status:** ACCEPTED RISK for v1

### T6 — Vault EOA Private Key Compromise
**Severity:** CRITICAL
**Description:** If the Polymarket signing EOA's private key is compromised, an attacker can drain the vault's Polymarket balance (place bets they control, or transfer USDC out of the Polymarket account). The Vault contract's USDC holdings (not yet sent to Polymarket) are unaffected.
**Mitigation:** Key stored in hardware HSM or secrets manager. Periodic key rotation with governance. Circuit breaker: if an unexpected Polymarket transaction originates from the vault EOA without a corresponding on-chain `BetAuthorized` event, halt all operations and alert.
**Status:** OPEN (key management design not finalized)

---

## 3. Smart Contract Attacks

### T7 — Nullifier Double-Spend
**Severity:** CRITICAL
**Description:** If the nullifier registry check fails (due to a bug), a user could spend the same note twice: submit two Withdrawal proofs using the same note, withdrawing twice the funds.
**Mitigation:** Nullifier check is the FIRST operation in `authorizeBet`, `creditSettlement`, and `withdraw`. Uses `require(!nullifiers[nullifier], "Spent")` before any state change. Must be present in all three functions and covered by unit tests.
**Status:** DESIGN LEVEL (not yet implemented; design is correct)

### T8 — Stale Merkle Root
**Severity:** HIGH
**Description:** Between when a user generates their ZK proof (using the current Merkle root) and when they submit the proof on-chain, other users may have made deposits or state transitions, changing the Merkle root. The proof will reference an outdated root and be rejected.
**Mitigation:** The Vault contract maintains a rolling window of the last 30 Merkle roots (`recentRoots[30]`). The proof is valid if its `merkle_root` matches any root in the window. This is the same approach as Tornado Cash's `MerkleTreeWithHistory`.
**Status:** DESIGN LEVEL

### T9 — Withdrawal Front-Running
**Severity:** HIGH
**Description:** The Withdrawal proof's `recipient_address` is a public input in a naive design. An MEV bot monitoring the Polygon mempool can replace the `recipient_address` with its own address before the transaction is confirmed.
**Mitigation:** The recipient address is a PRIVATE input in the Withdrawal circuit. Its Poseidon hash (`recipient_hash`) is the public input. The Vault contract calls `require(poseidon2(providedRecipient) == recipient_hash)` before transferring. The attacker cannot change the recipient without invalidating the proof.
**Status:** DESIGN LEVEL (built into circuit specification)

### T10 — Invalid Proof Spam / Gas Griefing
**Severity:** LOW
**Description:** An attacker can submit invalid proofs to the Vault contract, wasting gas (the attacker's own gas) or cluttering the contract's event log.
**Mitigation:** On-chain proof verification is gas-efficient regardless of backend — Groth16 (~250k gas) and UltraPLONK (~300-400k gas) are both acceptable at Polygon gas prices. The attacker pays their own gas for each invalid proof submission. No additional mitigation needed unless the attacker is subsidized. Rate limiting is possible but adds complexity. Final gas figures depend on the mainnet backend decision (see open-questions.md Q16).
**Status:** ACCEPTED RISK

### T11 — Circuit Upgrade Breaking Existing Commitments
**Severity:** HIGH
**Description:** If a bug is found in a ZK circuit and the verifier contract must be upgraded, existing commitments generated under the old circuit may be invalidated (if the new circuit has different public inputs) or remain vulnerable (if old proofs can still be generated against the old verifier).
**Mitigation:** Commitment structure must include a circuit version tag. The Vault maintains a registry of (circuit_version => verifier_address). A commitment is always redeemable against the verifier it was created under. New commitments use the newest circuit version.
**Status:** DESIGN LEVEL (circuit versioning not yet formally specified)

---

## 4. Economic Attacks

### T12 — Note Grinding / Pre-Image Attack
**Severity:** HIGH
**Description:** If an attacker can guess a user's `secret`, they can compute all the user's note commitments, nullifiers, and withdraw their funds.
**Mitigation:** `secret` must be generated using `crypto.getRandomValues()` (Web Crypto API), which provides 254 bits of entropy. Never generated with Math.random. Never reused across deposits. The frontend must enforce this.
**Status:** DESIGN LEVEL (must be enforced in SDK implementation)

### T13 — Vault Undercollateralization
**Severity:** HIGH
**Description:** Users' USDC is partially held in the Vault contract and partially held in the Polymarket account (as active bet collateral). If users submit simultaneous Withdrawal proofs while the Vault's liquid USDC is low (most of it is in active Polymarket positions), withdrawals will revert.
**Mitigation:** The Vault must reserve each depositor's initial deposit amount separately from trading capital. Specifically: the Vault contract holds `sum(all deposits)` in USDC. Funds flow to Polymarket only when bets are placed and return when markets settle. The Vault should track the total amount "in flight" (in active Polymarket positions) and enforce that `vault_usdc_balance >= sum(committed_deposits) - sum(in_flight_amounts)` before accepting new bet authorizations.
**Status:** OPEN (in-flight tracking mechanism not yet designed)

### T14 — Protocol Fee Claiming Bypass
**Severity:** MEDIUM
**Description:** If a protocol fee on profits is enforced only at the application layer (frontend) rather than in the ZK circuit, a user could construct a withdrawal proof that claims the full profit without deducting the fee.
**Mitigation:** Protocol fee must be enforced INSIDE the Withdrawal circuit. The fee rate is a public input (or a circuit constant). The circuit constrains `withdrawal_amount <= final_balance - fee(final_balance - deposit_amount)`. Fee rate changes must be handled via circuit versioning.
**Status:** OPEN (fee mechanism not yet designed; fee rate governance undefined)

---

## 5. Operational Risks

### T15 — Polymarket Account Ban
**Severity:** HIGH
**Description:** Polymarket's risk systems may detect the vault's EOA as a high-volume programmatic trader and ban the account. A ban prevents new bets but does not affect the Vault contract. All depositors retain the right to withdraw their current balance.
**Mitigation:** Implement a circuit breaker that pauses new bet authorizations if the Polymarket API returns 403 or account-specific error codes. New bets queue for processing once a new EOA is registered (Q12, multi-EOA rotation).
**Status:** OPEN (circuit breaker and EOA rotation not designed)

### T16 — Polymarket API Downtime During Bet Window
**Severity:** MEDIUM
**Description:** If Polymarket's CLOB API is down after a Bet Authorization proof is confirmed on-chain (the USDC is debited from the note) but before the order is submitted, the user loses the bet amount with no corresponding Polymarket order.
**Mitigation:** The Signing Layer must implement a persistent queue with retry logic. A `BetAuthorized` event that has not been executed must be retried for at least 1 hour before failing. After the retry window, a "reversal" mechanism must credit the bet_amount back to the user's note. This requires a Reversal proof type (similar to Cancellation Credit).
**Status:** OPEN (reversal mechanism not designed)

### T17 — Note Preimage Loss
**Severity:** HIGH (impacts individual users, not the protocol)
**Description:** A user who loses their note (the `(secret, balance, nonce)` preimage) permanently loses access to their vault funds. The Vault contract cannot identify the owner of a commitment without the secret.
**Mitigation:** Strong UX warnings. Optional encrypted note backup (see Q10). Consider whether a time-locked default withdrawal (e.g., funds claimable by the depositor address after 1 year of inactivity) is acceptable -- this would partially break the privacy model but prevent permanent fund loss.
**Status:** OPEN (recovery design pending Q10 resolution)

### T18 — Proof Relay IP / Timing Correlation Attack
**Severity:** HIGH
**Description:** Users never submit `authorizeBet` from their own wallet — the Proof Relay submits on-chain on their behalf, so the depositor's address does not appear in the bet authorization transaction. However, the user's browser must POST the ZK proof to the Proof Relay's API over HTTP(S). If the Relay logs IP addresses, an operator or adversary with access to Relay logs can correlate: "IP 1.2.3.4 submitted proof P at time T" with the on-chain `authorizeBet` event containing the matching nullifier, which appears seconds later. This links the depositor's IP to their bet, and IP can often be linked to a real-world identity.
**Mitigation:**
- Users should submit proofs to the Relay over Tor or a VPN. The frontend should surface a clear warning that direct submission leaks the IP-to-bet link.
- The Relay should NOT log source IPs or should immediately discard them after forwarding the transaction.
- Ideally, the Relay introduces a randomized delay (5-60 seconds) and batches multiple users' proofs before submitting, making timing correlation infeasible even for an observer with full Relay logs.
- Long-term: integrate with a decentralized relayer network (e.g., Gelato or a custom p2p relay) where no single node sees both the IP and the proof.
**Status:** OPEN — Relay privacy policy and batch/delay design not yet specified.

### T19 — Frontend Direct Transaction Attack (Implementation Risk)
**Severity:** CRITICAL
**Description:** If a developer implementing the frontend mistakenly wires the "Authorize Bet" button to call `Vault.authorizeBet()` directly from the user's connected wallet (e.g., via Wagmi's `writeContract`), the user's address will appear as `msg.sender` in the on-chain transaction. This directly and irreversibly links the depositor to the bet, breaking the core privacy invariant. This is an implementation error, not a protocol flaw, but it is easy to make and would be invisible to users.
**Mitigation:**
- The `authorizeBet` function in `Vault.sol` must NOT check `msg.sender` for authorization (it checks only the ZK proof). Any address can call it.
- CLAUDE.md must explicitly state: the frontend NEVER calls `authorizeBet` or any other Vault state-mutating function directly from the user's wallet. The only on-chain transaction the user's wallet initiates is `deposit()`.
- The Proof Relay is the ONLY authorized submitter for `authorizeBet`, `creditSettlement`. This must be enforced architecturally (the frontend has no way to submit on-chain txs other than deposit).
- Add an automated test: the frontend test suite should assert that no wallet-connected `writeContract` call is ever made to `authorizeBet` or `creditSettlement`.
**Status:** DESIGN LEVEL — must be explicitly enforced in CLAUDE.md and frontend architecture.

---

## 6. Attack Surface Summary

| # | Attack | Severity | Mitigation Status |
|---|---|---|---|
| T1 | Bet descriptor visibility | LOW | Closed (not a deanonymization vector) |
| T2 | Merkle leaf timing correlation | MEDIUM | Partial |
| T3 | Small anonymity set at launch | HIGH | Open |
| T4 | Signing layer front-running (v1) | CRITICAL | Open (commit-reveal needed) |
| T5 | Signing layer censorship (v1) | HIGH | Accepted (v1) |
| T6 | Vault EOA key compromise | CRITICAL | Open |
| T7 | Nullifier double-spend | CRITICAL | Design correct |
| T8 | Stale Merkle root | HIGH | Design correct |
| T9 | Withdrawal front-running | HIGH | Design correct (private recipient) |
| T10 | Invalid proof spam | LOW | Accepted |
| T11 | Circuit upgrade breaks commitments | HIGH | Design level |
| T12 | Note grinding | HIGH | Design level |
| T13 | Vault undercollateralization | HIGH | Open |
| T14 | Fee bypass | MEDIUM | Open |
| T15 | Polymarket account ban | HIGH | Open |
| T16 | API downtime during bet window | MEDIUM | Open |
| T17 | Note preimage loss | HIGH | Open |
| T18 | Proof Relay IP/timing correlation | HIGH | Open |
| T19 | Frontend direct transaction (impl risk) | CRITICAL | Design level |
