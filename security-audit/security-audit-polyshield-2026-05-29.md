# Security Audit Report: PolyShield

**Date**: 2026-05-29  
**Auditor**: Claude (Anthropic) via security-audit skill  
**Scope**: Full-stack — Smart Contracts (Solidity), ZKP Circuits (Noir), Backend (Node.js/TypeScript), Frontend (Next.js), Social Engineering / Trust Model  
**ZKP Framework**: Noir (UltraPLONK backend); Groth16 verifiers currently deployed (benchmarking state)  
**Smart Contract Language**: Solidity ^0.8.24  
**Backend Stack**: Node.js + Express + ethers.js v6 (signing-layer, proof-relay, indexer, mock-clob-server)  
**Frontend Stack**: Next.js + Wagmi + Viem + snarkjs (Groth16 prover)  
**Codebase**: `/Users/aria/Desktop/PolyShield`

---

## Executive Summary

PolyShield is a ZK-based privacy vault allowing multiple depositors to place Polymarket bets through a single vault EOA without on-chain linkage of depositor addresses to specific bets. The core privacy property is well-conceived, but **three Critical soundness vulnerabilities** exist across all credit-bearing ZK circuits: the `bet_cancel`, `cancel_credit`, and `settlement_credit` circuits do not bind the note being spent to the specific bet record being claimed. Any user who holds a valid note can steal another user's cancellation credit or settlement payout simply by supplying the victim's public `nullifier_of_bet`. This attack is silent, permanent, and drains funds with no recourse. Beyond the circuit soundness holes, two High findings threaten admin-key compromise scenarios (single-step ownership, untimelocked verifier replacement), and a High frontend ABI mismatch would silently break note recovery for all users after the first bet. The system should not be deployed to testnet until all Critical and High findings are resolved.

---

## Severity Summary

| Severity       | Count |
|----------------|-------|
| Critical       | 3     |
| High           | 3     |
| Medium         | 6     |
| Low            | 5     |
| Informational  | 4     |
| **Total**      | **21** |

---

## Findings by Layer

### ZKP Circuits

#### [ZK-01] `bet_cancel` circuit does not bind note to bet — cross-user cancellation credit theft

- **Severity**: Critical
- **Layer**: ZKP Circuit → Smart Contract
- **Location**: `packages/circuits/bet_cancel/src/main.nr:33-55`, `packages/contracts/src/Vault.sol:464-483`

**Description**:  
`bet_cancel` takes `nullifier_of_bet` as a public input and simply discards it (`let _ = nullifier_of_bet`). There is no circuit constraint linking the note being spent to the bet being claimed. The Vault only checks that `betRecords[nullifier_of_bet].status == FAILED`; it does not verify that the caller's note was the output of that specific bet authorization.

**Proof of Concept**:
1. Victim Y calls `authorizeBet`. A `BetAuthorized` event is emitted containing Y's `nullifier_of_bet` (the pre-bet nullifier) — this is **public on-chain**.
2. The signing layer calls `reportFOKFailure(nullifier_of_bet_Y)`, setting `betRecords[Y].status = FAILED`.
3. Attacker X holds any valid unspent note `(secret_X, balance_X, nonce_X, addr_X)` in the Merkle tree.
4. X constructs a `bet_cancel` proof using their own note and supplies `nullifier_of_bet = Y.nullifier_of_bet`.
5. The Vault verifies: bet exists ✓, bet is FAILED ✓, proof validates ✓ (X's note is in the tree).
6. X's note is nullified; a new note is created for X with `balance_X + Y.bet_amount`. `betRecords[Y_key].status = CANCELLED_CREDITED`.
7. Y can never reclaim their bet_amount — it has been permanently stolen.

**Fix**: Add a circuit constraint proving `nullifier_of_bet` equals the nullifier of the note one step before the current note:

```noir
// In bet_cancel/src/main.nr — after computing the current nullifier:
let pre_bet_nonce: Field = (nonce as Field) - 1;  // current note is post-bet, nonce = pre_bet + 1
let computed_nullifier_of_bet = bn254::hash_2([secret, pre_bet_nonce]);
assert(computed_nullifier_of_bet == nullifier_of_bet, "nullifier_of_bet must match pre-bet note");
```

This binds the note to the specific bet because `nullifier_of_bet = Poseidon2(secret, nonce-1)`, and `secret` is known only to the true owner.

**References**: [0xPARC ZK Bug Tracker](https://github.com/0xPARC/zk-bug-tracker) — under-constrained witness; [SWC-107](https://swcregistry.io/docs/SWC-107)

---

#### [ZK-02] `cancel_credit` circuit does not bind note to bet — cross-user N/A credit theft

- **Severity**: Critical
- **Layer**: ZKP Circuit → Smart Contract
- **Location**: `packages/circuits/cancel_credit/src/main.nr:40-56`, `packages/contracts/src/Vault.sol:491-521`

**Description**: Identical vulnerability class to ZK-01, affecting N/A market cancellations. The `cancel_credit` circuit discards `nullifier_of_bet` and `market_id` without constraint. Any user with a valid note can claim any ACTIVE or FILLED bet's N/A cancellation credit once the market resolves as N/A.

**Proof of Concept**: Same as ZK-01, but triggered by N/A market resolution instead of FOK failure. The Vault check `rec.status != BetStatus.ACTIVE && rec.status != BetStatus.FILLED` is the only ownership guard — it does not associate the bet with the caller's note.

**Fix**: Same pattern as ZK-01:

```noir
// In cancel_credit/src/main.nr:
let pre_bet_nonce: Field = (nonce as Field) - 1;
let computed_nullifier_of_bet = bn254::hash_2([secret, pre_bet_nonce]);
assert(computed_nullifier_of_bet == nullifier_of_bet, "nullifier_of_bet must match pre-bet note");
```

**References**: Same as ZK-01.

---

#### [ZK-03] `settlement_credit` circuit does not bind note to bet — cross-user settlement theft

- **Severity**: Critical
- **Layer**: ZKP Circuit → Smart Contract
- **Location**: `packages/circuits/settlement_credit/src/main.nr:43-47`, `packages/contracts/src/Vault.sol:386-420`

**Description**: The `settlement_credit` circuit discards `nullifier_of_bet` and `market_id` without constraint. An attacker who holds any valid note can steal another user's winning settlement payout by supplying the victim's `nullifier_of_bet` as a public input. The Vault injects `total_credit = shares_held * payout_per_share` from `betRecords[nullifier_of_bet]` — this correctly bounds the amount, but does not prevent a different user from claiming it.

**Proof of Concept**:
1. Victim Y has a winning FILLED bet with `expected_shares = S`, `outcome_side = 0`. `total_credit = S * payout_per_share = S`.
2. Attacker X has any valid unspent note in the tree.
3. X submits `creditSettlement` with `nullifier_of_bet = Y.nullifier`, `total_credit = S`.
4. Vault verifies arithmetic: `S * 1 == S` ✓. Proof verifies X's note ✓.
5. X's note balance increases by S. Y's bet record becomes `CREDITED`. Y can never claim their winnings.

**Fix**: Same constraint pattern:

```noir
// In settlement_credit/src/main.nr:
let pre_bet_nonce: Field = (nonce as Field) - 1;
let computed_nullifier_of_bet = bn254::hash_2([secret, pre_bet_nonce]);
assert(computed_nullifier_of_bet == nullifier_of_bet, "nullifier_of_bet must match pre-bet note");
```

**References**: Same as ZK-01.

---

### Smart Contracts

#### [SC-01] Single-step `Ownable` — ownership transfer to wrong address is permanent

- **Severity**: High
- **Layer**: Smart Contract
- **Location**: `packages/contracts/src/Vault.sol:19`

**Description**: `Vault` inherits from OpenZeppelin's `Ownable` (single-step transfer). If `transferOwnership` is called with a mistyped or wrong address, the owner key is permanently lost. The owner controls verifier addresses, the admin cancel timelock, and the signing-layer operator — losing ownership makes these permanently frozen at current values.

**Fix**: Replace `Ownable` with `Ownable2Step`:

```solidity
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
contract Vault is ReentrancyGuard, Ownable2Step {
```

**References**: [SWC-105](https://swcregistry.io/docs/SWC-105), [OpenZeppelin Ownable2Step](https://docs.openzeppelin.com/contracts/5.x/api/access#Ownable2Step)

---

#### [SC-02] `setVerifier` accepts `address(0)` and any contract — no timelock, instant rug surface

- **Severity**: High
- **Layer**: Smart Contract
- **Location**: `packages/contracts/src/Vault.sol:209-211`

**Description**: The owner can call `setVerifier(proofType, address(0))` which would make all subsequent proof verifications call `IVerifier(address(0)).verify(...)`, reverting every user transaction for that proof type. More critically, the owner can install a malicious verifier contract whose `verify()` always returns `true`, accepting any fabricated proof — enabling complete vault draining. There is no timelock on verifier changes; a compromised owner key can execute this atomically in a single block.

**Fix**: Add address validation and a timelock for verifier changes:

```solidity
mapping(uint8 => address) public pendingVerifiers;
mapping(uint8 => uint256) public verifierUpdateAt;
uint256 public constant VERIFIER_TIMELOCK = 48 hours;

function proposeVerifier(uint8 proofType, address verifier) external onlyOwner {
    require(verifier != address(0), "zero address");
    pendingVerifiers[proofType] = verifier;
    verifierUpdateAt[proofType] = block.timestamp + VERIFIER_TIMELOCK;
}

function acceptVerifier(uint8 proofType) external onlyOwner {
    require(block.timestamp >= verifierUpdateAt[proofType], "timelock active");
    verifiers[proofType] = pendingVerifiers[proofType];
}
```

**References**: [SWC-106](https://swcregistry.io/docs/SWC-106)

---

#### [SC-03] `resolveMarket` integer division silently zeros payout for non-standard markets

- **Severity**: Medium
- **Layer**: Smart Contract
- **Location**: `packages/contracts/src/Vault.sol:373-375`

**Description**: `payout_per_share = numerators[i] / denominator` uses integer division. For standard binary Polymarket markets (numerators = [denominator, 0]), this correctly yields 0 or 1. However if CTF stores fractional payouts (e.g., `numerators[0] = 500_000`, `denominator = 1_000_000`), the division truncates to 0 for all outcomes. The market is recorded as resolved (non-NA), but `payout_per_share = 0` for all outcomes, making winning bets unclaimable — funds are permanently locked in the vault. The `anyNonZero` guard prevents NA detection but does not catch this zero-payout-after-truncation case.

**Fix**: Add a post-division check:

```solidity
bool anyNonZeroAfterDiv = false;
for (uint256 i = 0; i < numerators.length; i++) {
    uint64 pps = uint64(numerators[i] / denominator);
    pendingCredit[circuit_key][uint8(i)] = pps;
    if (pps > 0) anyNonZeroAfterDiv = true;
}
if (!anyNonZeroAfterDiv) revert PayoutRoundsToZero();
```

**References**: [SWC-101](https://swcregistry.io/docs/SWC-101)

---

#### [SC-04] No zero-address checks in constructor

- **Severity**: Medium
- **Layer**: Smart Contract
- **Location**: `packages/contracts/src/Vault.sol:185-204`

**Description**: The constructor accepts nine address parameters (usdc, tree, nullifiers, onramp, offramp, ctf, signingLayerOperator, depositWallet, owner) without checking any for `address(0)`. A misconfigured deployment with a zero address for `usdc` or `tree` results in a permanently broken vault (no upgrade path).

**Fix**: Add `require(addr != address(0), "zero address")` for each critical parameter, or add assertions to the deployment script.

---

#### [SC-05] `setAdminCancelTimelock` has no minimum — owner can cancel any ACTIVE bet instantly

- **Severity**: Medium
- **Layer**: Smart Contract
- **Location**: `packages/contracts/src/Vault.sol:218-220`

**Description**: The owner can set `adminCancelTimelock = 0`, then immediately call `adminCancelBet` on any ACTIVE bet, forcing it to FAILED status. While users can still reclaim via `betCancellationCredit`, this allows the owner to grief any in-flight bet instantly and — when combined with the ZK-01/02/03 vulnerabilities before they are fixed — enables a two-step drain: force-cancel many bets, then steal cancellation credits.

**Fix**: Enforce a minimum timelock:

```solidity
function setAdminCancelTimelock(uint256 _seconds) external onlyOwner {
    require(_seconds >= 1 hours, "timelock too short");
    adminCancelTimelock = _seconds;
}
```

---

#### [SC-06] `MarketResolved` event always emits `numerators[0]` regardless of winning outcome

- **Severity**: Low
- **Layer**: Smart Contract
- **Location**: `packages/contracts/src/Vault.sol:379`

**Description**: `emit MarketResolved(circuit_key, uint64(numerators[0] / denominator), resolvedAt)` hardcodes the YES outcome payout regardless of which outcome actually won. For a NO-winning market (`numerators = [0, 1_000_000]`), the event emits `payout_per_share = 0` even though the NO payout is 1. Indexers and frontends relying on this event field display incorrect settlement data.

**Fix**: Remove the `payout_per_share` field from the event, or emit an array of per-outcome payouts. Require indexers to query `pendingCredit` directly.

---

#### [SC-07] `acknowledgePolymarketReturn` does not verify actual USDC balance

- **Severity**: Low
- **Layer**: Smart Contract
- **Location**: `packages/contracts/src/Vault.sol:239-244`

**Description**: `acknowledgePolymarketReturn(amount)` decrements `deployedToPolymarket` without verifying USDC actually returned to the vault. A compromised operator can call this repeatedly with inflated amounts, enabling a subsequent `fundPolymarketWallet` call that over-deploys USDC, draining the vault.

**Fix**: Cross-reference against actual vault USDC balance before and after, or require the USDC transfer and acknowledgement to occur atomically.

---

#### [SC-08] Misleading comment in `creditSettlement` — losing bets do not revert

- **Severity**: Informational
- **Layer**: Smart Contract
- **Location**: `packages/contracts/src/Vault.sol:401-402`

**Description**: The comment `// losing bets (payout_per_share == 0) revert here` is incorrect. The code does not revert for losing bets — it allows them to call `creditSettlement` with `total_credit = 0`, updating the bet status to CREDITED with no balance change. This is functionally correct but the comment misleads readers.

---

### Backend

#### [BE-01] Mock CLOB server admin endpoints have no authentication and carry the operator signing key

- **Severity**: Medium
- **Layer**: Backend
- **Location**: `packages/backend/mock-clob-server/src/admin.ts:1-215`, `packages/backend/mock-env/src/index.ts:75-88`

**Description**: The mock CLOB server's `/admin/*` endpoints have no authentication. The code comment says "only reachable on localhost" but this is not enforced — there is no IP binding or auth middleware. The admin endpoints can: (1) settle any market on Anvil using `VAULT_EOA_PRIVATE_KEY`, (2) call `Vault.reportFilled` directly using the operator key, (3) expose full server state. If accidentally exposed (container network, reverse proxy misconfiguration, shared staging environment), an external attacker gains complete control over market settlement and bet fill status. The mock-env orchestrator also hardcodes all Anvil private keys — acceptable for dev, but a CI secret leak risk if these keys are accidentally reused upstream.

**Fix**: Bind the admin router to localhost only and add an environment guard:

```typescript
// In mock-clob-server's index.ts startup:
if (process.env.NODE_ENV === 'production') {
  throw new Error('mock-clob-server must not run in production');
}

// In admin.ts:
adminRouter.use((req, res, next) => {
  if (req.hostname !== 'localhost' && req.hostname !== '127.0.0.1') {
    res.status(403).json({ error: 'admin endpoints: localhost only' });
    return;
  }
  next();
});
```

---

#### [BE-02] No rate limiting on proof relay endpoints

- **Severity**: Medium
- **Layer**: Backend
- **Location**: `packages/backend/proof-relay/src/api.ts`, `packages/backend/proof-relay/src/index.ts`

**Description**: The proof relay accepts `POST /relay/bet`, `/relay/settlement`, `/relay/withdrawal`, etc. with no rate limiting. Each relay call submits an on-chain transaction, consuming the relayer's ETH and nonce. A single IP can flood these endpoints, burning nonces, consuming gas, and degrading the nonce manager.

**Fix**: Add `express-rate-limit`:

```typescript
import rateLimit from 'express-rate-limit';
const relayLimiter = rateLimit({ windowMs: 60_000, max: 10, message: 'too many relay requests' });
app.use('/relay/', relayLimiter);
```

**References**: [OWASP A05](https://owasp.org/Top10/A05_2021-Security_Misconfiguration/)

---

#### [BE-03] `catchUpMissedBets` scans all history from block 0 — mainnet RPC timeout risk

- **Severity**: Low
- **Layer**: Backend
- **Location**: `packages/backend/signing-layer/src/eventListener.ts:44-81`

**Description**: On every signing-layer startup, `catchUpMissedBets` calls `vault.queryFilter(filter, 0, "latest")` scanning the full contract history. On Polygon mainnet after months of operation, this exceeds the 10,000-event cap on Alchemy/Infura's `eth_getLogs` endpoint, causing startup to fail or hang. Missed bets would not be recovered, leaving user funds stuck in ACTIVE status.

**Fix**: Persist the last-processed block number to disk or a database. On startup, scan only from `max(lastProcessedBlock - safetyBuffer, deployBlock)`.

---

### Frontend

#### [FE-01] `BetAuthorized` ABI in `recoverNotes` is missing `outcome_side` — note recovery silently broken

- **Severity**: High
- **Layer**: Frontend
- **Location**: `packages/frontend/src/lib/notes.ts:289-292`

**Description**: The ABI fragment used to parse `BetAuthorized` events during note recovery is:

```typescript
const betAuthorizedEvent = parseAbiItem(
  'event BetAuthorized(bytes32 indexed nullifier, bytes32 market_id, bytes32 position_id, uint64 expected_shares, uint256 bet_amount, uint64 price, bytes32 new_commitment)',
)
```

But `Vault.sol` emits:

```solidity
event BetAuthorized(
    bytes32 indexed nullifier,
    bytes32 market_id,
    bytes32 position_id,
    uint64 expected_shares,
    uint256 bet_amount,
    uint64 price,
    uint8 outcome_side,   // ← MISSING IN FRONTEND ABI
    bytes32 new_commitment
)
```

`outcome_side` is absent. This shifts all subsequent fields left by one position in the decoded args. When `recoverNotes` accesses `ev.args.new_commitment`, it reads `outcome_side` (uint8) instead of the actual `new_commitment` (bytes32). The state machine advances with a garbage commitment value, producing completely wrong note commitments and nullifiers. All post-bet note recovery is silently incorrect for any user who clears their localStorage or uses a new device.

**Fix**: Add the missing field:

```typescript
const betAuthorizedEvent = parseAbiItem(
  'event BetAuthorized(bytes32 indexed nullifier, bytes32 market_id, bytes32 position_id, uint64 expected_shares, uint256 bet_amount, uint64 price, uint8 outcome_side, bytes32 new_commitment)',
)
```

---

#### [FE-02] `pendingCredit` ABI uses wrong mapping key count — NO-bet recovery shows wrong payout

- **Severity**: Medium
- **Layer**: Frontend
- **Location**: `packages/frontend/src/lib/notes.ts:451-456`

**Description**: During note recovery, `pendingCredit` is read using a single-argument ABI:

```typescript
abi: [{ type: 'function', name: 'pendingCredit', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint64' }], ... }],
args: [receipt.condition_id!],
```

But the actual Vault declares `mapping(bytes32 => mapping(uint8 => uint64)) public pendingCredit`, whose Solidity-generated getter takes two arguments: `(bytes32, uint8)`. Calling with one argument always silently reads `pendingCredit[market_id][0]` (the YES outcome slot). Users with NO bets on a NO-winning market see the YES payout (0) during recovery, even though their actual payout is 1. The Vault enforces the correct value on-chain, but displayed balances in the recovery flow are wrong.

**Fix**:

```typescript
abi: [{
  type: 'function', name: 'pendingCredit',
  inputs: [{ type: 'bytes32' }, { type: 'uint8' }],
  outputs: [{ type: 'uint64' }],
  stateMutability: 'view'
}],
functionName: 'pendingCredit',
args: [receipt.condition_id!, receipt.side === 'NO' ? 1 : 0],
```

---

#### [FE-03] `inferBalanceFromCommitment` uses $1 USDC step — fails for non-integer balances

- **Severity**: Low
- **Layer**: Frontend
- **Location**: `packages/frontend/src/lib/notes.ts:521-534`

**Description**: The fallback balance inference scans in `1_000_000` (1 USDC) increments up to $50,000 — 50,000 Poseidon4 calls. Any balance that is not a whole USDC amount (e.g., after a bet fee deduction of $0.20) will never be found, returning `null`. The fallback silently uses the previous balance, producing incorrect note state. The synchronous loop would also freeze the UI main thread.

**Fix**: Store balance in on-chain events or recover it via contract storage. Remove the brute-force inference and surface an explicit error if balance cannot be determined.

---

### Social Engineering / Trust Model

#### [SE-01] Owner key is a single EOA — verifier replacement and admin actions are instant with no multisig

- **Severity**: Medium
- **Layer**: Social Engineering

**Description**: The Vault owner controls verifier addresses, the admin cancel timelock, and the operator address — all with immediate effect, no governance delay, no multi-party approval. A phished or compromised owner key allows an attacker to install a malicious verifier (see SC-02) and drain all funds within a single Ethereum block. There is no pause mechanism (see SE-02).

**Fix**: Transfer ownership to a 2-of-3 or 3-of-5 Safe multisig before testnet deployment. Add a TimelockController (minimum 48 hours) as the Vault owner, with the multisig as the proposer.

---

#### [SE-02] No on-chain emergency pause

- **Severity**: Medium
- **Layer**: Social Engineering

**Description**: There is no `Pausable` mechanism. If a vulnerability is actively exploited, the fastest available defense is replacing verifiers — which itself has no timelock (SC-02). If a critical bug is found while user funds are at risk, the operator cannot stop the exploit without accepting other security trade-offs.

**Fix**: Inherit `Pausable` and add `whenNotPaused` to all state-mutating user-facing functions (`deposit`, `authorizeBet`, `creditSettlement`, `withdraw`, `betCancellationCredit`, `naCancellationCredit`). Gate `pause()` behind the multisig or operator role.

**References**: [OpenZeppelin Pausable](https://docs.openzeppelin.com/contracts/5.x/api/utils#Pausable)

---

#### [SE-03] Mock CLOB server encodes privileged production behavior without environment gate

- **Severity**: Informational
- **Layer**: Social Engineering
- **Location**: `packages/backend/mock-clob-server/src/admin.ts`

**Description**: The mock-clob-server admin endpoints can call `Vault.resolveMarket` and `Vault.reportFilled` using the production `VAULT_EOA_PRIVATE_KEY` if the key is shared between mock and signing layer env files. In a staging environment where the mock server accidentally points at a real Vault, any LAN user can settle markets and mark bets as filled without Polymarket confirmation.

**Fix**: The mock server should refuse to start if `NODE_ENV=production` or if the RPC URL resolves to a non-local chain. Add chain-ID assertions at startup:

```typescript
const network = await provider.getNetwork();
if (network.chainId !== 31337n) throw new Error('mock-clob-server: only for local Anvil (chainId 31337)');
```

---

#### [SE-04] No bug bounty or documented incident response plan

- **Severity**: Informational
- **Layer**: Social Engineering

**Description**: There is no mention of a bug bounty program, security contact, or incident response plan in any documentation. For a protocol handling user funds, both are expected before public deployment.

**Fix**: Publish a security contact (`security@polyshield.xyz` or similar) in the README and on the frontend. Consider an Immunefi bounty covering the Vault and circuits before mainnet.

---

## Cross-Layer Attack Chains

### Attack Chain 1: Silent Cross-User Fund Theft via Unconstrained `nullifier_of_bet`

**Severity**: Critical  
**Layers Involved**: ZKP Circuit → Smart Contract

**Narrative**:
1. Victim Y authorizes a bet. The `BetAuthorized` event emits `nullifier_of_bet_Y` — permanently public on chain.
2. The signing layer calls `reportFOKFailure(nullifier_of_bet_Y)`, setting Y's bet to FAILED.
3. Attacker X holds any valid unspent note `(secret_X, balance_X, nonce_X, addr_X)` in the Merkle tree — even a freshly deposited note.
4. X generates a `bet_cancel` proof using their own note and supplies `nullifier_of_bet = nullifier_of_bet_Y`. The circuit verifies X's note ✓; it does not constrain that `nullifier_of_bet_Y` relates to X's secret (`let _ = nullifier_of_bet` is a no-op).
5. The Vault verifies: bet exists ✓, bet is FAILED ✓, proof valid ✓, nullifier X not spent ✓.
6. X's note is nullified. New note created for X with `balance_X + Y.bet_amount`. `betRecords[Y_key].status = CANCELLED_CREDITED`.
7. Y calls `betCancellationCredit` — reverts with `BetNotFailed`. Y's funds are permanently stolen.

**Root Cause**: ZK-01.  
**Fix**: ZK-01 fix breaks this chain at step 4 — the proof requires `nullifier_of_bet = Poseidon2(secret_X, nonce_X - 1)`, which cannot equal `nullifier_of_bet_Y` since X ≠ Y.

---

### Attack Chain 2: Admin-Key Compromise → Malicious Verifier → Vault Drain

**Severity**: Critical  
**Layers Involved**: Social Engineering → Smart Contract

**Narrative**:
1. Attacker phishes the vault owner's private key via targeted spear-phishing.
2. With the owner key, attacker immediately calls `setVerifier(BET_AUTH, malicious_contract)` where `malicious_contract.verify()` always returns `true`. No timelock — change takes effect in the same block.
3. Attacker calls `authorizeBet(fake_proof, {...})` with a fabricated proof and claims arbitrary funds.
4. With `WITHDRAWAL` verifier also replaced, attacker calls `withdraw(fake_proof, {withdrawal_amount: vault_balance})` to drain all USDC.
5. Total vault drain in 2-3 transactions. No pause, no timelock, no secondary approval.

**Root Cause**: SC-01 (single-step ownership) + SC-02 (no verifier timelock).  
**Fix**: SC-02 fix (48h timelock) + SE-01 fix (multisig owner) each extend the attack window from 0 blocks to days, allowing users to exit.

---

### Attack Chain 3: Mock CLOB in Staging with Shared Operator Key → Unauthorized Market Settlement

**Severity**: High  
**Layers Involved**: Social Engineering → Backend → Smart Contract

**Narrative**:
1. Developer runs `pnpm dev:mock` in a staging environment with `VAULT_CONTRACT_ADDRESS` pointing to a testnet Vault and the same `VAULT_EOA_PRIVATE_KEY` as the signing layer.
2. Mock CLOB server starts on port 3001 with no IP restriction on admin endpoints.
3. A third party on the same network discovers `POST /admin/settle-market` with no authentication.
4. They POST `{ conditionId: "0x...", payoutNumerators: [1,0], payoutDenominator: 1 }`.
5. The mock server calls `Vault.resolveMarket(conditionId)` using `VAULT_EOA_PRIVATE_KEY` — a real on-chain transaction setting `pendingCredit[market_id][0] = 1` immediately.
6. Users can now call `creditSettlement` against a market that has not actually resolved on the real Polymarket CTF.
7. If the Vault holds USDC, users (or the attacker via ZK-03) claim settlement payouts for bets that were never filled on Polymarket.

**Root Cause**: BE-01 (unauthenticated admin endpoints) + SE-03 (shared operator key between mock and signing layer).  
**Fix**: BE-01 fix (localhost binding + production guard) + SE-03 fix (separate operator keys per environment) breaks this chain at step 3.

---

## Recommendations Roadmap

Ordered by priority (Critical first):

| Priority | ID    | Layer    | Action                                                                 | Effort |
|----------|-------|----------|------------------------------------------------------------------------|--------|
| 1        | ZK-01 | Circuit  | Add `nullifier_of_bet` binding constraint in `bet_cancel`             | Low    |
| 2        | ZK-02 | Circuit  | Add `nullifier_of_bet` binding constraint in `cancel_credit`          | Low    |
| 3        | ZK-03 | Circuit  | Add `nullifier_of_bet` binding constraint in `settlement_credit`      | Low    |
| 4        | SC-02 | Contract | Add 48h timelock + zero-address guard to verifier changes             | Medium |
| 5        | FE-01 | Frontend | Fix `BetAuthorized` ABI — add `outcome_side` field                    | Low    |
| 6        | SC-01 | Contract | Replace `Ownable` with `Ownable2Step`                                 | Low    |
| 7        | SE-01 | Trust    | Transfer ownership to multisig + TimelockController before testnet    | Medium |
| 8        | SE-02 | Trust    | Add `Pausable` to Vault                                               | Low    |
| 9        | BE-01 | Backend  | Add localhost-only binding + `NODE_ENV` guard to mock CLOB admin      | Low    |
| 10       | SC-05 | Contract | Add 1-hour minimum to `setAdminCancelTimelock`                        | Low    |
| 11       | BE-02 | Backend  | Add `express-rate-limit` to proof relay endpoints                     | Low    |
| 12       | SC-03 | Contract | Guard `resolveMarket` against zero-payout-after-truncation            | Low    |
| 13       | FE-02 | Frontend | Fix `pendingCredit` ABI — pass `outcome_side` as second argument      | Low    |
| 14       | SC-04 | Contract | Add zero-address checks to all constructor parameters                 | Low    |
| 15       | SC-07 | Contract | Document / restrict `acknowledgePolymarketReturn` trust model         | Low    |
| 16       | BE-03 | Backend  | Persist last-processed block for catchup scan instead of scanning 0  | Medium |
| 17       | FE-03 | Frontend | Remove balance brute-force inference; use event data                  | Medium |
| 18       | SE-04 | Trust    | Publish security contact and bug bounty before public launch          | Low    |

---

## Tools Recommended for Offline Analysis

- **[Slither](https://github.com/crytic/slither)**: `slither packages/contracts/src/ --solc-remaps "@openzeppelin=packages/contracts/lib/openzeppelin-contracts"` — automated Solidity static analysis; catches reentrancy patterns, unused returns, access control issues.
- **[Halmos](https://github.com/a16z/halmos)**: Symbolic execution for Solidity; especially useful for verifying nullifier double-spend properties and arithmetic in `creditSettlement`.
- **[Echidna](https://github.com/crytic/echidna)**: Fuzz testing for Vault invariants (e.g., `sum_of_note_balances <= usdc.balanceOf(vault)`, double-spend impossibility).
- **[Noir Analyzer](https://github.com/noir-lang/noir/tree/master/tooling/lsp)**: Static analysis for Noir circuits via the LSP; checks for unused variables and unconstrained signals.
- **[Semgrep](https://semgrep.dev/)**: `semgrep --config=auto packages/backend packages/frontend` — backend injection patterns, prototype pollution, insecure deserialization.
- **[npm audit](https://docs.npmjs.com/cli/v10/commands/npm-audit)**: Run in each package workspace — `ethers`, `snarkjs`, and `wagmi` are high-value supply-chain targets.
- **[Trivy](https://github.com/aquasecurity/trivy)**: `trivy fs .` — combined secret scanning + dependency vulnerability scan across all workspaces.

---

## References

- [SWC-101 Integer Overflow/Underflow](https://swcregistry.io/docs/SWC-101)
- [SWC-105 Unprotected Ether Withdrawal](https://swcregistry.io/docs/SWC-105)
- [SWC-106 Unprotected SELFDESTRUCT Instruction](https://swcregistry.io/docs/SWC-106)
- [SWC-107 Reentrancy](https://swcregistry.io/docs/SWC-107)
- [0xPARC ZK Bug Tracker — Under-Constrained Witnesses](https://github.com/0xPARC/zk-bug-tracker)
- [Noir Unconstrained Functions](https://noir-lang.org/docs/noir/concepts/unconstrained)
- [OWASP A05 Security Misconfiguration](https://owasp.org/Top10/A05_2021-Security_Misconfiguration/)
- [OWASP API Security Top 10](https://owasp.org/www-project-api-security/)
- [OpenZeppelin Ownable2Step](https://docs.openzeppelin.com/contracts/5.x/api/access#Ownable2Step)
- [OpenZeppelin Pausable](https://docs.openzeppelin.com/contracts/5.x/api/utils#Pausable)
- [OpenZeppelin TimelockController](https://docs.openzeppelin.com/contracts/5.x/api/governance#TimelockController)
- [Immunefi Bug Bounty Platform](https://immunefi.com/)
- [CWE-918 SSRF](https://cwe.mitre.org/data/definitions/918.html)
