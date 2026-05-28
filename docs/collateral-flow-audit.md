# Collateral Flow Audit — Polymarket Money Model

**Audited:** `Vault.sol`, `redemptionPipeline.ts`, `orderBuilder.ts`, `MockCTF.sol`, `MockCollateralOfframp.sol`, `MockDeploy.s.sol`
**Context:** Polymarket upgraded to CTF Exchange V2 and deposit wallets on April 28, 2026. All new API accounts use deposit wallets, pUSD, and `POLY_1271` (signature type 3) orders. This audit evaluates whether the codebase correctly handles the fact that all betting collateral and CTF shares live in Polymarket's deposit wallet, not in the Vault contract.

---

## The Correct Money Model

Understanding the actual flow is prerequisite to understanding every bug below.

```
DEPOSIT:
  User USDC → Vault.deposit() → [Vault holds USDC]
  Vault → onramp.deposit(amount) → [Vault receives pUSD]
  Vault → pUSD.transfer(depositWallet, amount) → [depositWallet holds pUSD]

BET PLACEMENT:
  depositWallet [holds pUSD] → CLOB FOK order fills → CTF Exchange V2 takes pUSD
  depositWallet [now holds CTF ERC-1155 shares]

SETTLEMENT (win):
  CTF resolves → depositWallet calls ctf.redeemPositions() → depositWallet receives pUSD
  depositWallet → pusd.approve(offramp, amount) → offramp.withdraw(amount) → depositWallet receives USDC
  depositWallet → usdc.transfer(vault, amount) → [Vault receives USDC]
  Operator calls Vault.resolveMarket() → users can call creditSettlement

WITHDRAWAL:
  User proves ZK balance → Vault.withdraw() → usdc.safeTransfer(recipient, amount)
```

The core invariant: **at all times, `usdc.balanceOf(vault) + pusd_equivalent_in_depositWallet >= sum_of_all_valid_note_balances`.**

The current code breaks this invariant at the very first step.

---

## BUG-C1 — CRITICAL: Vault never funds the deposit wallet. USDC sits idle in the contract.

**Files:** `Vault.sol` · `ICollateralOnramp.sol` · `MockDeploy.s.sol`

**What happens now:**
`Vault.deposit()` pulls USDC from the user and stores it at `address(this)`. No subsequent call converts it to pUSD or sends it to the deposit wallet. `ICollateralOnramp` is imported and stored as a state variable but is called exactly zero times in the codebase. In `MockDeploy.s.sol`, the onramp is explicitly passed as `address(0)`:

```solidity
s_vault = new Vault(
    address(s_usdc),
    ...
    address(0), // onramp — not needed locally
    ...
);
```

There is also no `MockCollateralOnramp` contract, so the onramp flow has never been tested at any layer.

**Consequence:**
The deposit wallet always holds zero pUSD. Every FOK order submitted by the Signing Layer will be rejected by the CLOB with "not enough balance". The Signing Layer will then call `reportFOKFailure` on every bet, permanently deducting `bet_amount` from the user's note with zero actual order placement. Users' notes are debited but no bet ever reaches Polymarket.

**Fix — add to `Vault.sol`:**

```solidity
// New state
uint256 public deployedToPolymarket; // USDC-equivalent currently in depositWallet

// New error
error InsufficientVaultLiquidity();

// New function — operator callable, moves USDC through onramp → pUSD → depositWallet
function fundPolymarketWallet(uint256 amount) external nonReentrant {
    if (msg.sender != signingLayerOperator) revert OnlyOperator();
    if (usdc.balanceOf(address(this)) < amount) revert InsufficientVaultLiquidity();
    deployedToPolymarket += amount;

    // Convert USDC → pUSD via onramp; pUSD arrives at this contract
    IERC20 pusd = IERC20(onramp.pusdAddress()); // or store pusdAddress separately
    usdc.approve(address(onramp), amount);
    onramp.deposit(amount);

    // Forward pUSD to the deposit wallet (Polymarket proxy)
    pusd.safeTransfer(depositWallet, amount);

    emit FundedPolymarketWallet(amount);
}

// Called by operator after redemption pipeline completes and USDC is back in Vault
function acknowledgePolymarketReturn(uint256 amount) external {
    if (msg.sender != signingLayerOperator) revert OnlyOperator();
    if (amount > deployedToPolymarket) revert InvalidAmount();
    deployedToPolymarket -= amount;
    emit PolymarketReturnAcknowledged(amount);
}
```

**Also add `MockCollateralOnramp.sol`** for dev testing:
```solidity
contract MockCollateralOnramp {
    IERC20 public usdc;
    IERC20 public pusd;
    address public vault;

    function deposit(uint256 amount) external {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        pusd.safeTransfer(msg.sender, amount); // 1:1 mock
    }
}
```

Update `MockDeploy.s.sol` to deploy and wire the mock onramp instead of `address(0)`.

---

## BUG-C2 — CRITICAL: Offramp called from the operator EOA, not from the deposit wallet

**File:** `packages/backend/signing-layer/src/redemptionPipeline.ts` · `offrampPusdToVault()`

**What happens now:**
After `tryDirectDepositWalletRedeem` executes `ctf.redeemPositions()` via `depositWallet.execute()`, pUSD lands in the **deposit wallet**. Then `offrampPusdToVault()` is called with `operatorWallet` as the signer:

```ts
const usdc = new ethers.Contract(config.usdcAddress, USDC_ABI, operatorWallet);
const offramp = new ethers.Contract(config.offrampAddress, OFFRAMP_ABI, operatorWallet);
// ...checks operatorWallet's USDC balance...
await usdc.approve(config.offrampAddress, amount, { nonce });
await offramp.withdraw(amount, { nonce });
```

The production `CollateralOfframp.withdraw()` burns pUSD from the caller and returns USDC to the caller. The operator EOA holds zero pUSD — all pUSD is in the deposit wallet. This call would either revert (insufficient pUSD balance) or, worse, succeed only because the mock does not validate pUSD ownership at all.

**Why the mock hides this:**
`MockCollateralOfframp.withdraw()` simply does `usdc.safeTransferFrom(msg.sender, vault, amount)`. It does not touch pUSD. The mock also compensates via `mockInfuseVaultUsdc()` which mints USDC directly — a fabricated funds path that has no production equivalent. The entire settlement path in dev is synthetic.

**Fix:**
The offramp call, the pUSD approval, and the USDC transfer to Vault must all be issued from the deposit wallet via `depositWallet.execute()` calls (or a Polymarket relayer `WALLET` batch in production). The sequence after `redeemPositions()`:

```ts
// Step 1 — approve offramp from depositWallet
const approveData = pusdIface.encodeFunctionData("approve", [config.offrampAddress, amount]);
await depositWallet.execute(config.pusdAddress, 0, approveData);

// Step 2 — call offramp from depositWallet → USDC arrives at depositWallet
const offrampData = offrampIface.encodeFunctionData("withdraw", [amount]);
await depositWallet.execute(config.offrampAddress, 0, offrampData);

// Step 3 — transfer USDC from depositWallet to Vault
const transferData = usdcIface.encodeFunctionData("transfer", [config.vaultContractAddress, amount]);
await depositWallet.execute(config.usdcAddress, 0, transferData);
```

With the April 2026 upgrade, all `depositWallet.execute()` calls must go through the Polymarket relayer as `WALLET` batch transactions (see [Deposit Wallets — Submit a Deposit Wallet Batch](https://docs.polymarket.com/trading/deposit-wallets)), not as direct EOA calls. The current `tryDirectDepositWalletRedeem` pattern is incompatible with the new deposit wallet contract model.

---

## BUG-C3 — CRITICAL: Redemption amount uses `bet_amount` instead of `expected_shares`, and ignores winning side

**File:** `packages/backend/signing-layer/src/redemptionPipeline.ts` · `sumBetVolumeForMarket()`

**What happens now:**
```ts
const estimatedOfframp = await sumBetVolumeForMarket(
    provider, config.vaultContractAddress, conditionId
);
// sumBetVolumeForMarket sums `bet_amount` from ALL BetAuthorized events for conditionId
// regardless of outcome_side
await offrampPusdToVault(provider, operatorWallet, estimatedOfframp);
```

This has two compounding errors:

1. **Wrong field.** `bet_amount` is the USDC spent to buy shares. After a win, the CTF pays out `expected_shares` pUSD (1 pUSD per winning share). For a bet at price P: `expected_shares ≈ bet_amount / P`. At price 0.4 (YES at 40 cents), `expected_shares = bet_amount / 0.4 = 2.5 × bet_amount`. The function underestimates the available pUSD by up to 100×.

2. **Wrong filter.** The function sums bets on both sides of the market. Only the winning side has non-zero CTF redemption value. Summing losing bets and passing that to offramp inflates the call amount by the losing side's total, causing `offramp.withdraw()` to request more pUSD than the deposit wallet holds.

**Fix:**

```ts
async function computeRedemptionAmount(
    provider: ethers.JsonRpcProvider,
    vaultAddress: string,
    conditionId: string,
    winningSide: number  // 0=YES, 1=NO; derived from payout_numerators
): Promise<bigint> {
    const vault = new ethers.Contract(vaultAddress, VAULT_ABI, provider);
    const filter = vault.filters.BetAuthorized(null, conditionId);
    const logs = await vault.queryFilter(filter, 0, "latest");
    let total = 0n;
    for (const log of logs) {
        const parsed = vault.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (!parsed) continue;
        // BetAuthorized has outcome_side in betRecords, not in the event directly.
        // Load betRecord to check outcome_side, or add outcome_side to the event.
        const rec = await vault.betRecords(parsed.args.nullifier);
        if (Number(rec.outcome_side) !== winningSide) continue;
        if (Number(rec.status) !== BET_STATUS_FILLED) continue;
        total += parsed.args.expected_shares as bigint;
    }
    return total;
}
```

Note: `outcome_side` is not currently in the `BetAuthorized` event (only in `betRecords`). Either add it to the event (requires a Vault.sol change) or load it from `betRecords` per bet. The former is cheaper off-chain.

---

## BUG-C4 — CRITICAL: `ClobClient` missing `funderAddress` — all production orders rejected

**File:** `packages/backend/signing-layer/src/orderBuilder.ts`

**What happens now:**
```ts
const client = new ClobClient({
    host: clobHost,
    chain: Chain.POLYGON,
    signer: wallet as any,
    creds: { key, secret, passphrase },
    signatureType: SignatureTypeV2.POLY_1271,
});
```

Per the Polymarket deposit wallet documentation:
> **Order is rejected as invalid signature** — Check all four signature inputs: `signatureType` must be `3`, order `maker` must be the deposit wallet, order `signer` must be the deposit wallet...

Without `funderAddress`, the `ClobClient` sets `maker` and `signer` to the operator EOA, not to the deposit wallet. The CTF Exchange V2 validates orders through ERC-1271 on the deposit wallet contract. An order with `maker = operatorEOA` will fail this check unconditionally.

**Fix:**
```ts
const client = new ClobClient({
    host: clobHost,
    chain: Chain.POLYGON,
    signer: wallet as any,
    creds: { key, secret, passphrase },
    signatureType: SignatureTypeV2.POLY_1271,
    funderAddress: config.depositWalletAddress,  // ADD THIS
});
```

Also: before the first order, the deposit wallet must have approved the CTF Exchange V2 for pUSD spending. This approval must be submitted as a relayer `WALLET` batch from the deposit wallet. There is currently no code path for the one-time approval setup.

---

## BUG-C5 — CRITICAL: `MockCTF.redeemPositions` is a no-op — settlement money path is untested

**File:** `packages/contracts/src/mocks/MockCTF.sol`

**What happens now:**
```solidity
function redeemPositions(address, bytes32, bytes32, uint256[] calldata) external {}
```

The real `ConditionalTokens.redeemPositions()`:
1. Burns the caller's ERC-1155 conditional tokens
2. Computes payout: `amount * payoutNumerators[outcome] / payoutDenominator`
3. Transfers that much pUSD (collateral token) back to the caller

The mock does none of this. Zero pUSD is ever sent back. The mock dev pipeline compensates by calling `mockInfuseVaultUsdc()` which mints USDC directly to the Vault — a completely fabricated path. The real settlement chain (redeemPositions → pUSD → offramp → USDC → Vault) is never exercised or tested.

Additionally, `MockCTF.setBalance()` is never called by the mock CLOB when orders fill. So `ctf.balanceOf(depositWallet, positionId)` always returns 0, meaning `hasVaultShares` is always false, meaning the mock always takes the fabricated path. The real path (shares exist → redeem → offramp) is never reached even in mock mode.

**Fix — update `MockCTF.sol`:**

```solidity
contract MockCTF is ICTF {
    // ...existing mappings...
    IERC20 public pusd; // set in constructor

    // Called by mock CLOB when an order fills: give depositWallet the CTF shares
    function mintShares(address account, uint256 id, uint256 amount) external {
        _balances[id][account] += amount;
    }

    function redeemPositions(
        address collateralToken,
        bytes32,
        bytes32 conditionId,
        uint256[] calldata indexSets
    ) external {
        uint256[] memory numerators = _numerators[conditionId];
        uint256 denominator = _denominators[conditionId];
        if (denominator == 0) return;

        uint256 totalPayout = 0;
        for (uint256 i = 0; i < indexSets.length; i++) {
            // Each indexSet bit corresponds to an outcome slot
            uint256 slot = _indexSetToSlot(indexSets[i]);
            if (slot < numerators.length) {
                uint256 sharesHeld = _balances[indexSets[i]][msg.sender];
                if (sharesHeld > 0) {
                    uint256 payout = sharesHeld * numerators[slot] / denominator;
                    _balances[indexSets[i]][msg.sender] = 0;
                    totalPayout += payout;
                }
            }
        }
        if (totalPayout > 0) {
            IERC20(collateralToken).safeTransfer(msg.sender, totalPayout);
        }
    }
}
```

The mock CLOB's `orders.ts` must also call `ctf.mintShares(depositWalletAddress, positionId, sharesAmount)` when a FOK order matches.

---

## BUG-H1 — HIGH: No solvency invariant — `withdraw()` will revert with a generic ERC-20 error when funds are deployed

**File:** `Vault.sol` · `withdraw()`

When any portion of the Vault's USDC is deployed to Polymarket via `fundPolymarketWallet()` (once implemented), the Vault's `usdc.balanceOf(address(this))` will be less than the sum of all user note balances. A `withdraw()` call for a valid ZK proof will then revert inside `usdc.safeTransfer()` with a raw ERC-20 revert, not a meaningful protocol error. Users will see a failed transaction with no informative reason.

**Fix:**
```solidity
error InsufficientLiquidity(uint256 available, uint256 requested);

// In withdraw(), before the transfer:
uint256 available = usdc.balanceOf(address(this));
if (available < inputs.withdrawal_amount)
    revert InsufficientLiquidity(available, inputs.withdrawal_amount);
```

The frontend should also pre-check `vault.usdc.balanceOf(vaultAddress)` vs the withdrawal amount and surface a "funds currently deployed — check back after market settlement" message before proof generation.

---

## BUG-H2 — HIGH: `tryDirectDepositWalletRedeem` incompatible with the new Polymarket deposit wallet model

**File:** `packages/backend/signing-layer/src/redemptionPipeline.ts`

Post-April-2026, deposit wallets are ERC-1967 proxies deployed by the Polymarket deposit wallet factory. They do NOT expose a generic `execute(address, uint256, bytes)` interface. Wallet actions must go through Polymarket's relayer as signed `WALLET` batch transactions:

```
POST relayer /submit
{
  "type": "WALLET",
  "from": "0xOwnerEOA",
  "to": "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07",  // factory
  "nonce": "...",
  "signature": "0x65ByteEIP712Sig",
  "depositWalletParams": { "depositWallet": "...", "calls": [...] }
}
```

The current code calls `depositWallet.execute(ctf, 0, redeemData)` directly from the operator EOA. This will revert because:
1. The deposit wallet does not have an `execute(address, uint256, bytes)` function
2. Even if it did, direct calls from an external EOA won't be authorized

The Signing Layer must use `@polymarket/builder-relayer-client` to submit `WALLET` batch transactions for all deposit wallet actions (redeemPositions, pUSD approve, USDC transfer to Vault).

---

## BUG-H3 — HIGH: Deposit wallet pUSD approval to CTF Exchange V2 never set up

Before the first order can fill, the deposit wallet must have approved pUSD spending to CTF Exchange V2. This approval must come from the deposit wallet itself (via a `WALLET` batch), not from the operator EOA. There is no code in the system — not in the Signing Layer startup, not in the deployment script, not anywhere — that submits this approval. The first-ever `updateBalanceAllowance()` call will fail with "allowance missing" and no order will ever fill.

**Fix:** Add a one-time setup step to the Signing Layer's startup sequence:

```ts
async function ensureDepositWalletApprovals(relayerClient) {
    // approve pUSD to CTF Exchange V2
    const approveData = erc20Iface.encodeFunctionData("approve", [CTF_EXCHANGE_V2, MaxUint256]);
    await relayerClient.executeDepositWalletBatch([
        { target: PUSD_ADDRESS, value: "0", data: approveData }
    ], depositWalletAddress, deadline);

    // sync CLOB balance cache (signature_type=3)
    await clobClient.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
}
```

---

## MEDIUM: Hardcoded index sets `[1, 2]` in `tryDirectDepositWalletRedeem`

**File:** `packages/backend/signing-layer/src/redemptionPipeline.ts`

```ts
const redeemData = ctfIface.encodeFunctionData("redeemPositions", [
    config.pusdAddress, ZERO_BYTES32, conditionId, [1, 2],
]);
```

Index sets `[1, 2]` (`0b01` and `0b10`) correspond to the two outcome slots of a standard binary market. This is correct for most Polymarket markets but would be wrong for:
- Multi-outcome markets (if ever added): require index sets `[1, 2, 4, ...]`
- Negative-risk markets: use a different adapter entirely

Derive the index sets from the number of outcomes:
```ts
const outcomeCount = numerators.length;
const indexSets = Array.from({ length: outcomeCount }, (_, i) => 1 << i);
```

---

## MEDIUM: `outcome_side` missing from `BetAuthorized` event

**File:** `Vault.sol`

`outcome_side` is stored in `betRecords` but not emitted in `BetAuthorized`. The redemption pipeline needs `outcome_side` to filter winning bets (BUG-C3 fix). Currently this requires an additional `betRecords()` RPC call per bet during settlement, which is expensive at scale.

**Fix:** Add `uint8 outcome_side` to the `BetAuthorized` event:
```solidity
event BetAuthorized(
    bytes32 indexed nullifier,
    bytes32 market_id,
    bytes32 position_id,
    uint64 expected_shares,
    uint256 bet_amount,
    uint64 price,
    uint8 outcome_side,    // ADD
    bytes32 new_commitment
);
```

---

## PRIVACY: `BetAuthorized` event leaks full bet descriptor (known open question)

**File:** `Vault.sol`

The `BetAuthorized` event publicly emits `market_id`, `position_id`, `expected_shares`, `bet_amount`, and `price`. An on-chain observer can:
- Track the vault's aggregate position in every market
- Statistically attribute individual bets if a user is the only one betting on a niche market
- Front-run CLOB orders by watching `BetAuthorized` before the Signing Layer submits to the CLOB

This is open question Q6/Q-bet-descriptor in `docs/open-questions.md`. The current implementation is fully public. If any bet descriptor fields are to be hidden, the ZK proof must commit to an encrypted or hashed form, and the Signing Layer must receive a decryption path. This decision gates circuit design changes.

---

## Summary Table

| ID | Severity | File(s) | Issue |
|---|---|---|---|
| C1 | Critical | `Vault.sol`, `MockDeploy.s.sol` | No onramp step — Vault never funds deposit wallet; `ICollateralOnramp` is dead code |
| C2 | Critical | `redemptionPipeline.ts` | Offramp called from operator EOA, not deposit wallet; pUSD never reaches Vault |
| C3 | Critical | `redemptionPipeline.ts` | Redemption amount uses `bet_amount` (all sides) instead of `expected_shares` (winning side only) |
| C4 | Critical | `orderBuilder.ts` | `ClobClient` missing `funderAddress` — all production POLY_1271 orders rejected |
| C5 | Critical | `MockCTF.sol` | `redeemPositions` is a no-op; settlement money path is completely untested |
| H1 | High | `Vault.sol` | No solvency invariant; `withdraw()` fails with raw ERC-20 error when funds are deployed |
| H2 | High | `redemptionPipeline.ts` | `depositWallet.execute()` incompatible with post-April-2026 relayer-based deposit wallet model |
| H3 | High | Signing Layer startup | Deposit wallet pUSD approval to CTF Exchange V2 never initialized |
| M1 | Medium | `redemptionPipeline.ts` | Hardcoded index sets `[1, 2]` — wrong for non-binary markets |
| M2 | Medium | `Vault.sol` | `outcome_side` missing from `BetAuthorized` event — forces expensive on-chain lookups during settlement |
| P1 | Privacy | `Vault.sol` | `BetAuthorized` event leaks full bet descriptor publicly (open question, no fix yet decided) |

---

## Recommended Implementation Order

1. **BUG-C1** — Add `fundPolymarketWallet()` to Vault.sol, add `MockCollateralOnramp`, wire in `MockDeploy`. This unblocks all testing.
2. **BUG-C5** — Fix `MockCTF.redeemPositions` to actually transfer pUSD. Add `mintShares` call in mock CLOB. This makes the mock test the real settlement path.
3. **BUG-C4** — Add `funderAddress` to `ClobClient` init. Immediate one-line fix, unblocks production order placement.
4. **BUG-H3** — Add deposit wallet approval setup to Signing Layer startup.
5. **BUG-C2 + H2** — Rewrite `offrampPusdToVault` to use relayer `WALLET` batch. This is the most complex fix; requires integrating `@polymarket/builder-relayer-client` into the Signing Layer.
6. **BUG-C3** — Fix `sumBetVolumeForMarket` → `computeRedemptionAmount`, filter by winning side and use `expected_shares`.
7. **BUG-H1** — Add `InsufficientLiquidity` guard to `withdraw()` and `deployedToPolymarket` state tracking.
8. **M1 + M2** — Polish fixes; implement after core flow is working.
