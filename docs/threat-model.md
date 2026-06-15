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

### T4 — Signing Layer Front-Running (v1)
**Severity:** MEDIUM (for v1; reassessed 2026-05-31, see Q26)
**Description:** In v1, the centralized signing operator receives bet parameters (market, side, amount, price) before executing the Polymarket order. Two sub-risks must be separated:
  - **Degraded-fill front-running (mitigated by design):** bets are FOK at a user-set limit price (Q4/Q7). If the operator trades ahead and moves the price, the user's FOK simply fails to fill (`FOK_ORDER_NOT_FILLED_ERROR`) and the bet_amount is reclaimed via Bet Cancellation Credit. The operator cannot make the user overpay or fill them worse than their limit, so this form is already capped by the FOK/limit-price design.
  - **Information leak / copy-trading (residual):** the operator must read the plaintext bet to construct and sign the order, so it learns the user's directional view and can trade it on a side account. This is the alpha-leak Polyshield exists to kill, relocated from the public chain to the operator.
**Mitigation (v1):** Accept the information-leak residual under operational policy (project-run operator; no proprietary trading on vault markets; documented). Commit-reveal is rejected: it defends against third parties racing a revealed mempool tx, not against the *executor itself*, which by definition reads the plaintext at execution time. You cannot have the operator sign an order it cannot read, so commit-reveal adds latency and a transaction without addressing the residual.
**Status:** ACCEPTED RISK (v1 info-leak); degraded-fill capped by FOK/limit price; resolved cryptographically in v2. See Q26.
**Note:** The residual is eliminated in v2 (TEE sees parameters only inside the enclave). v3/threshold signing has been dropped from the roadmap (Q3).

### T5 — Signing Layer Censorship
**Severity:** HIGH (for v1)
**Description:** In v1, the operator can refuse to execute specific bets (censorship) or execute them selectively. A censored user's funds remain safe (they can withdraw), but they cannot place bets.
**Mitigation:** In v1, document the censorship risk. In v2, the TEE's code is public and auditable; the enclave is programmatically required to execute all valid proofs. In v3, threshold signers must collectively agree to censor, which requires coordination among N parties.
**Status:** ACCEPTED RISK for v1

### T6 — Vault EOA Private Key Compromise
**Severity:** CRITICAL
**Description:** If the Polymarket signing EOA's private key is compromised, an attacker can drain the vault's Polymarket balance (place bets they control, or transfer USDC out of the Polymarket account). The Vault contract's USDC holdings (not yet sent to Polymarket) are unaffected.
**Mitigation:** The blast radius is bounded to whatever sits in the Polymarket Deposit Wallet at the moment of compromise, NOT the whole pool: the Vault contract releases USDC only against ZK-verified proofs, so the EOA key alone cannot pull the at-rest majority. The primary lever is bounding the in-flight float. **As built (FC-7, JIT — `collateral-deployment-strategy-comparison.md` Option 3): collateral is deployed only at bet time, so the exposed amount is just the small accreted residual buffer — this de-escalates the threat substantially in the current model.** The SEC-007 `deploymentCap` (the FC-6 `maxInFlight` ceiling) is the hard on-chain bound and remains the primary lever as the system moves to the Option-4 base-buffer model. Secondary hardening: KMS/HSM-backed signing so the raw key is never extractable (CLAUDE.md's "env var only" is acceptable for local dev only), the fenced deposit-wallet owner + relayer-only outbound path (the deposit wallet is now an executor-gated proxy, `MockDepositWallet` locally / Polymarket deposit-wallet proxy in prod), plus an Indexer circuit breaker that halts signing on any EOA / Deposit-Wallet action lacking a matching on-chain event. EOA rotation is Q12 (v2).
**Status:** MITIGATED in the current model by FC-7 (JIT) — exposure is the residual buffer, bounded by `deploymentCap`. Residual risk tracked with the Option-4 buffer-management work (FC-6) and the TEE/fenced-owner roadmap.

---

## 3. Smart Contract Attacks

### T7 — Nullifier Double-Spend
**Severity:** CRITICAL
**Description:** If the nullifier registry check fails (due to a bug), a user could spend the same note twice: submit two Withdrawal proofs using the same note, withdrawing twice the funds.
**Mitigation:** Nullifier check is the FIRST operation in `authorizeBet`, `creditSettlement`, and `withdraw`. Uses `require(!nullifiers[nullifier], "Spent")` before any state change. Must be present in all three functions and covered by unit tests.
**Status:** DESIGN LEVEL (not yet implemented; design is correct)

### T8 — Stale Merkle Root
**Severity:** HIGH
**Description:** Between when a user generates their ZK proof (using a Merkle root) and when they submit the proof on-chain, other users may have made deposits or state transitions, each of which inserts a leaf and produces a new root. If the referenced root has been evicted from the history window by the time the tx executes, the proof is rejected (`UnknownRoot`).
**Mitigation:** The tree maintains a rolling window of the last **1024** Merkle roots (FC-3) with O(1) `mapping(bytes32 => bool) knownRoots` membership. The proof is valid if its `merkle_root` is in the window (`CommitmentMerkleTree.isKnownRoot`, a single mapping read). This is the Tornado-Cash `MerkleTreeWithHistory` approach with a larger, O(1) window.

**Clarification (2026-05-30): this does NOT serialize state changes to one transaction per block.** The root changes on every `tree.insert` and `merkle_root` is a public input to every proof, but concurrency is safe for two reasons: (1) membership is monotonic, a leaf present under root R is present under every later root; (2) an old root plus its old path verify together, because the circuit checks `computed_root == merkle_root` and the contract accepts R as long as it is within the last 1024 roots, so users never refresh their path mid-flight. Many state-changing transactions can therefore land in the same block, each carrying whatever recent root it was built against. The only true serialization point is per-note nullifier double-spend (T7), which is intended.

**Real constraint:** the referenced root must still be among the last `ROOT_WINDOW` (now 1024) roots when the tx executes. Each successful state transition inserts exactly one leaf = one new root. A 30s-2min client proof straddles ≈15–60 Polygon blocks; the 1024 window gives ample headroom (~10 fully-saturated blocks at ~100 ZK txs/block, or far more at realistic load) so stale-root reverts are no longer a practical concern.

**Resolved (FC-3, implemented 2026-06-03):** `ROOT_WINDOW` raised 30 → 1024 and `isKnownRoot` switched from the O(HISTORY_SIZE) array scan to a `mapping(bytes32 => bool)` lookup with a mapping-keyed ring buffer for eviction, making the large window O(1) per verify. No circuit changes. Widening the window is soundness-neutral (membership is monotonic; double-spend is nullifier-gated, T7).
**Status:** RESOLVED (FC-3 implemented; window now 1024 with O(1) lookup)

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
**Mitigation (corrected 2026-05-31, see Q27):** The note format `Poseidon4(secret, balance, nonce, owner_address)` is frozen (a protocol constant), and commitments are bare hashes in the tree, not bound to any circuit; only *proofs* bind to a verifier. So three upgrade cases must be handled differently, and the previous "always redeemable against the verifier it was created under" guidance is wrong for the common case:
  - **Soundness bug, public inputs unchanged (common):** the buggy verifier must be REVOKED, not kept live. Because the note format is frozen, a fixed verifier with identical public inputs spends the exact same existing notes, so revoke-and-replace loses nothing. Keeping the old verifier enabled (as the prior text implied) is the actual danger.
  - **Public-input change (e.g. Q4 adding `price`):** treat as a new circuit version; the contract may accept both during a transition window. Notes are unaffected because the format did not change.
  - **Note-format change:** the only case that truly invalidates commitments. Forbidden without sign-off; if ever forced, needs leaf-level version tags and a dual-tree migration with old notes still spendable via the old (sound) circuit.
  Implement a `mapping(circuitId => mapping(version => address))` verifier registry with an active-version pointer and a per-verifier enable/disable flag, plus an emergency pause that can halt a specific verifier the instant unsoundness is found.
**Status:** DESIGN LEVEL. Registry + emergency-pause design captured in Q27.

---

### T21 — Instant Owner-Controlled Contract Upgrade (UUPS)
**Severity:** CRITICAL
**Description:** As of the UUPS conversion (2026-06-02), **every** production contract — `Vault`, `CommitmentMerkleTree`, `NullifierRegistry`, `PoseidonT3Hasher`, and all 8 Groth16 verifier adapters — is an implementation behind an `ERC1967Proxy`, and `_authorizeUpgrade` is gated by **plain `onlyOwner` with no timelock**. The owner can therefore replace any contract's logic in a single transaction. A malicious or compromised owner key can upgrade the `Vault` to a version that (a) transfers all USDC to an attacker (fund drain), (b) leaks the depositor↔bet linkage by logging or re-routing state (de-anonymization), or (c) disables nullifier/Merkle checks. This is strictly more powerful than the verifier-slot swap (which is 48h-timelocked) and the EOA-key risks in T6: it is total control over funds and the privacy invariant, effective immediately. The verifier adapters additionally expose an owner-only `setBase(address)` (adopt a new VK without a proxy migration) — a second, instant owner lever on proof verification.
**Mitigation:**
  - The owner role **MUST** be a multisig (e.g. Safe with a high threshold) or HSM-backed key in production — never a hot EOA. This is the only thing standing between the owner key and the entire pool.
  - Consider adding an upgrade timelock (e.g. reuse the existing 48h `VERIFIER_TIMELOCK` pattern) so users can exit before a malicious upgrade lands. This was **deliberately not implemented** for the initial mainnet test (instant upgrades chosen to allow immediate hotfixes); revisit before scaling TVL.
  - Storage-layout discipline: implementations disable initializers (`_disableInitializers()` in the constructor); each upgradeable contract reserves a trailing `__gap`; `CommitmentMerkleTree`'s array layout is frozen. A botched upgrade that reorders storage could corrupt the Merkle/nullifier state — mitigated by review + `forge inspect storageLayout` snapshots, not yet by automated `validateUpgrade` tooling.
**Status:** ACCEPTED for the initial mainnet test, CONDITIONAL on a multisig/HSM owner. Trust assumption documented in CLAUDE.md and architecture.md. Timelock + automated storage-layout validation are recommended fast-follows.

---

## 4. Economic Attacks

### T12 — Note Grinding / Pre-Image Attack
**Severity:** HIGH
**Description:** If an attacker can guess a user's `secret`, they can compute all the user's note commitments, nullifiers, and withdraw their funds.
**Mitigation:** secrets are **wallet-derived, not random** (P3+ / FC-13), so entropy comes from the wallet's ECDSA key, not a CSPRNG. V2: `secret_i = keccak256(master_seed ‖ i) mod p` where `master_seed = keccak256(wallet.sign(V2 msg))`; V1 (legacy): `keccak256(wallet.sign(per-index msg)) mod p`. Each is a 254-bit field element an attacker cannot guess without the wallet key. Secrets are never reused across deposits (distinct per index) and never persisted. (`crypto.getRandomValues()` is no longer used for note secrets; the old random-secret mitigation applies only to any residual P1/P2 notes.)
**Status:** MITIGATED by wallet-derived secrets (FC-13). The frontend must never fall back to a weaker source.

### T13 — Vault Undercollateralization
**Severity:** HIGH
**Description:** Users' USDC is partially held in the Vault contract and partially held in the Polymarket account (as active bet collateral). If users submit simultaneous Withdrawal proofs while the Vault's liquid USDC is low (most of it is in active Polymarket positions), withdrawals will revert.
**Mitigation:** In the as-built model deposits rest as USDC in the Vault; capital reaches Polymarket only via the operator `fundPolymarketWallet` call. **As built (FC-7, JIT) that call is now made per bet, for the exact uncovered shortfall, just before the order** — so almost all user funds stay at-rest and permissionlessly withdrawable; the deployed amount is the small residual buffer, bounded by the SEC-007 `deploymentCap`. The note is debited at `authorizeBet` in the same step the funds are earmarked, so the bet leg is self-balancing (`liquid_USDC == sum(unspent note balances)` through the bet). Settlement does not credit a note before the redeemed pUSD has offramped back to the Vault (`acknowledgePolymarketReturn` follows the offramp). `InsufficientLiquidity(available, requested)` in `withdraw` is the backstop. Moving to Option 4 raises the standing buffer (and thus this exposure) by design, capped by `deploymentCap`.
**Status:** MITIGATED in the current JIT model (FC-7); exposure bounded by `deploymentCap`. Re-evaluate buffer sizing when the Option-4 base-buffer policy (FC-6) lands.

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
**Mitigation:** **Largely closed by wallet-derived secrets (FC-13).** The wallet IS the backup — there is no separate preimage to lose. A user with only their wallet reconstructs every note from on-chain events with ONE signature (`recoverNotes`, V2 master seed; V1 per-index as fallback). The encrypted IndexedDB note cache survives reloads (so recovery is rarely needed), and a silent reconcile auto-syncs new on-chain notes. Residual loss only for any legacy P1/P2 random-secret notes, which still need the Q10 ECIES backup.
**Status:** MITIGATED for wallet-derived (P3+) notes via FC-13 recovery; OPEN only for residual P1/P2 random-secret notes.

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

## 6. Soundness Attacks

### T20: Deposit Balance Forgery (Committed Balance != Deposited Amount)
**Severity:** CRITICAL
**Description:** `Vault.deposit(bytes32 commitment, uint256 amount)` transfers `amount` USDC and inserts `commitment` into the tree, but it cannot read the `balance` field inside the commitment (the commitment hides it), and there is no deposit-time ZK proof. Every spending circuit checks balance only relatively (`bet_auth`: `current_balance >= bet_amount`; `withdrawal`: `withdrawal_amount <= final_balance`). Nothing ties the committed `balance` to the deposited `amount`. A depositor can call `deposit(Poseidon4(secret, 200e6, 0, owner), amount = 100e6)`: the contract pulls 100 USDC but inserts a commitment that opens to a 200 USDC balance. A later valid withdrawal for 200 USDC passes every assertion (the note really is in the tree; `200 <= 200`) and pays out 200, stealing 100 from the shared pool. The `InsufficientLiquidity` guard in `withdraw` only makes the loss surface later (the pool drains and honest users cannot withdraw); it is not a defense. `owner_address` is likewise unbound at deposit, so W-to-W is unenforced at the entry point.
**Mitigation (SOLVED, direction approved, see FC-2 in `docs/future-changes.md`):** Re-instate the deposit proof as MANDATORY (prior docs wrongly classed it optional/trivial). Add a small `deposit` circuit: private `secret`; public `(commitment, amount, owner_address)`; constraint `commitment == Poseidon4(secret, amount, 0, owner_address)`. `Vault.deposit` becomes `deposit(proof, commitment, amount)` and calls the verifier with public inputs `(commitment, amount, uint256(uint160(msg.sender)))`, forcing `balance == amount`, `nonce == 0`, and `owner_address == msg.sender`, with `secret` still private. No change to the Poseidon4 commitment formula or the four existing circuits; one new verifier slot (`DEPOSIT = 5`). A global "total committed == total deposited" invariant is uncheckable per-note without revealing balances and only fails after the theft, so it is not an acceptable substitute.
**Status:** SOLVED at design level (mandatory deposit proof). Treat as a blocker for any deposit-handling code until implemented.

---

## 7. Attack Surface Summary

| # | Attack | Severity | Mitigation Status |
|---|---|---|---|
| T1 | Bet descriptor visibility | LOW | Closed (not a deanonymization vector) |
| T2 | Merkle leaf timing correlation | MEDIUM | Partial |
| T3 | Small anonymity set at launch | HIGH | Open |
| T4 | Signing layer front-running (v1) | MEDIUM | Accepted v1 (FOK/limit cap; info-leak); v2 TEE (Q26) |
| T5 | Signing layer censorship (v1) | HIGH | Accepted (v1) |
| T6 | Vault EOA key compromise | CRITICAL | Mitigated by FC-7 (JIT) — exposure = residual buffer, capped by `deploymentCap` |
| T7 | Nullifier double-spend | CRITICAL | Design correct |
| T8 | Stale Merkle root | HIGH | Resolved (FC-3: 1024-root O(1) window) |
| T9 | Withdrawal front-running | HIGH | Design correct (private recipient) |
| T10 | Invalid proof spam | LOW | Accepted |
| T11 | Circuit upgrade breaks commitments | HIGH | Design level (registry + pause, Q27) |
| T12 | Note grinding | HIGH | Mitigated (wallet-derived secrets, FC-13 — entropy from the wallet key) |
| T13 | Vault undercollateralization | HIGH | Mitigated by FC-7 (JIT) — funds rest in Vault; `InsufficientLiquidity` backstop |
| T14 | Fee bypass | MEDIUM | Open |
| T15 | Polymarket account ban | HIGH | Open |
| T16 | API downtime during bet window | MEDIUM | Open |
| T17 | Note preimage loss | HIGH | Mitigated for P3+ (FC-13 one-signature recovery); open only for residual P1/P2 |
| T18 | Proof Relay IP/timing correlation | HIGH | Open |
| T19 | Frontend direct transaction (impl risk) | CRITICAL | Design level |
| T20 | Deposit balance forgery (committed != deposited) | CRITICAL | Solved (mandatory deposit proof, FC-2) |
| T21 | Instant owner-controlled UUPS upgrade (all contracts) | CRITICAL | Accepted for initial test, CONDITIONAL on multisig/HSM owner; timelock recommended fast-follow |
| T22 | Operator signs two contradictory fill attestations (FC-9) | HIGH | Mitigated off-chain: single-write attestation store (sign exactly one terminal attestation per bet) |
| T23 | adminCancelBet refunds a healthy filled-but-unclaimed bet (FC-9) | MEDIUM | Mitigated: 3-day timelock floor (7-day default) + owner-trusted; bounded by existing owner-upgrade trust |
| T24 | Backend index / recovery-data trust (proof-relay) | MEDIUM | Mitigated: serves only public data; worst case = incomplete recovery, never theft/de-anon |
| T25 | Client at-rest cache + in-memory master seed (FC-13) | MEDIUM | Mitigated at intended level (at-rest obfuscation + no-persist-secret); residual = full active-device compromise |
| T26 | Accrued fees not reserved vs JIT deployment (FC-14) | LOW | Accepted: owner-trusted, small, deploymentCap-bounded, withdrawFees only transiently reverts |

### T22 — FC-9 operator attestation: the single-terminal-signing invariant (load-bearing)

Under FC-9 the operator reports fill status by signing an off-chain EIP-712 `OperatorAttestation` that the user submits with their credit proof; the Vault recovers the signer, requires it equals `signingLayerOperator`, then injects the attested values (filled/spent/sold/proceeds). This is gasless for the protocol and the trust class is unchanged from the old on-chain `report*` (operator-attested values), matching the v2 TEE-attested-value path.

**The chain cannot adjudicate two *different* valid signatures for one bet.** The on-chain guards prevent replaying the *same* signature (the post-bet note nullifier is single-use, and the credit functions advance `BetStatus` to a terminal value that is never reset). But if the operator ever signed BOTH, say, a PARTIAL and a FILLED attestation for one bet, the user could choose whichever pays more (claim a partial refund and then settle the "full" position). Therefore the operator MUST sign **exactly one** terminal attestation per bet — enforced off-chain by a single-write attestation store (`signing-layer/src/attestationStore.ts`: `INSERT … ON CONFLICT DO NOTHING`, never re-sign). The chain is only a backstop against same-signature replay. A double-signing operator is the same trust failure as a misreporting operator; v2 (TEE/multisig operator) mitigates both.

### T23 — FC-9 changes adminCancelBet's meaning

With operator status reporting moved off-chain, an unclaimed-but-filled bet stays `ACTIVE` on-chain, so "ACTIVE == stuck" is no longer true, and a banned operator can still *sign* an attestation off-chain (a ban blocks order placement, not local signing). `adminCancelBet` is now an owner-trusted last resort for a permanently-gone operator (lost keys), with a 3-day timelock floor (7-day default via `initializeV2`). The owner must confirm off-chain that no fill/attestation occurred before cancelling; the residual power to refund a genuinely-filled bet is bounded by the fact that the owner can already UUPS-upgrade the whole Vault (T21).

### T24 — Backend index / recovery-data trust (proof-relay)

The proof-relay maintains a backend mirror of public on-chain state (`CachedMerkleTree` → `/merkle-path`, `VaultEventIndex` → `/recovery-data`, `/events`) so clients don't re-scan the chain (see `architecture.md` §2.4/§2.5). Trust analysis:

- **No de-anonymization.** The backend stores only PUBLIC data: opaque leaf commitments and anonymous spend events (`nullifier`, `new_commitment`, amounts — no owner). Only `Deposited` is wallet-keyed, and deposits are public by design. The secret — and therefore the wallet↔note link — never leaves the browser, so the backend *cannot* learn which notes/spends belong to a wallet. Serving `/recovery-data/:depositor` returns the wallet's public deposits + ALL anonymous spends; the client matches its own with its secret.
- **Cannot forge funds.** Recovery's replay only acts on an event whose nullifier equals the wallet's *own* derived nullifier (`Poseidon2(secret, nonce)`). A backend that injects fabricated events can't produce one matching a secret it doesn't have, so injected events are ignored. **Worst case from a malicious/buggy backend = *incomplete* recovery** (omitting real events → some notes not rebuilt), never theft.
- **Merkle path integrity.** A forged merkle path can't mint funds — the on-chain verifier checks the proof's `merkle_root` against the contract's `knownRoots`, and a path that doesn't reproduce a known root is rejected. The cache additionally asserts each appended leaf's computed root equals `LeafInserted.newRoot` and falls back to on-the-fly computation on mismatch. **Open hardening:** the client does not yet verify the served `currentRoot` against the on-chain tree (would catch a backend serving a stale/wrong leaf set for path generation).
- **Availability, not safety.** The index/RPC is a *liveness* dependency (down → can't recover/serve paths via the backend), not a safety one — the on-chain tree remains authoritative and the frontend retains a direct-chain fallback. Requires an archive RPC with a usable getLogs range (§2.5); a pruned/10-block-capped RPC degrades availability, not safety.

### T25 — Client-side at-rest cache + in-memory master seed (FC-13)

FC-13 moved the note cache to **encrypted IndexedDB** and introduced an **in-memory master seed**. Trust analysis:

- **At-rest cache encryption is obfuscation, not full-device protection.** The note cache (`polyshield:notes`/`polyshield:activity` — the de-anonymizing linkage) is encrypted with a non-extractable AES-GCM `CryptoKey` whose raw bytes can never be exported. This defeats casual inspection, malicious extensions, and backup/sync scrapers reading raw storage. It does NOT defend a fully compromised device/browser that can drive the page's own crypto (it can ask the opaque key to decrypt). This is an accepted limitation and a deliberate decision (random IDB key, not wallet-derived) so the portfolio hydrates with zero signatures. Mitigating factor: note **secrets are never persisted**, so even a full IDB dump yields balances/linkage but no spendable key.
- **Master seed is memory-only.** The V2 master seed (which derives all note secrets) lives only in JS memory for the session and is cleared on disconnect/tab close — never written to localStorage/IndexedDB/server. This preserves the "secret is not persisted" invariant (a stolen device at rest yields no key) at the cost of one signature per session/reload. Deliberate decision over persisting an encrypted seed.
- **Non-sensitive counters stay in localStorage.** `deposit_index`, `last_block`, `chain_fp` remain plaintext in localStorage — none reveal the wallet↔note link (deposit count is already public via `/recovery-data`).
- **Migration.** The one-time import of any legacy plaintext localStorage cache into the encrypted store then deletes the plaintext copies, so old plaintext linkage doesn't linger.
**Status:** MITIGATED at the intended level (at-rest obfuscation + no-persist-secret); residual risk = full active-device compromise, unchanged from before FC-13.

### T26 — Accrued fees not reserved against JIT deployment (FC-14, accepted)

`feeAccumulator` (claimable USDC owed to `feeRecipient`) sits in the pool but is NOT reserved when the operator deploys capital via `fundPolymarketWallet`, so if most liquid USDC is deployed to Polymarket, `withdrawFees` can transiently revert (insufficient liquid balance) and competes with user withdrawals for liquid USDC. **Accepted, not fixed (FC-14 decision):** the `feeRecipient` is owner-trusted, fees are small relative to the pool, deployment is JIT and bounded by `deploymentCap`, and `withdrawFees` only ever fails *temporarily* (it succeeds once redeemed pUSD offramps back via `acknowledgePolymarketReturn`). No funds are at risk — purely a liveness nuisance for the fee claimer. A future hardening could reserve `feeAccumulator` in `fundPolymarketWallet`'s liquidity check (balance − feeAccumulator ≥ amount).
**Note (FC-14 SC-01 fix):** `feeAccumulator` now holds only *claimable* (non-refundable) fees — provisional protocol fees live in `betProtocolFee` until earned — so the related "withdraw a fee that is later refunded → underflow" vector is **eliminated**; T26 is now strictly the liquidity-vs-deployment nuance below.
**Status:** ACCEPTED (owner-trusted, small, bounded, recoverable).
