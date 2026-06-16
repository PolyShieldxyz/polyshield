import { ethers } from "ethers";
import pino from "pino";
import { config } from "./config";
import { signingLayerNonceManager } from "./nonceManager";
import { getDepositWalletExecutor, DepositWalletExecutor, WalletCall } from "./depositWalletExecutor";
import { toFieldSafe } from "./marketRegistry";
import { DEPLOY_BLOCK } from "./logScan";
import { fetchAllBetAuthorized, BetAuthorizedRecord } from "./vaultEventSource";

const logger = pino({ name: "redemption-pipeline" });

const ZERO_BYTES32 = "0x" + "00".repeat(32);

// BN254 scalar field modulus. The Vault stores BetAuthorized.market_id as the conditionId
// reduced mod this (circuit_key), so an event's market_id must be compared against the
// reduced conditionId — not the raw CTF conditionId.
const BN254_P = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;

/** True when a BetAuthorized event's (reduced) market_id matches this conditionId. */
function sameMarket(eventMarketId: string, conditionId: string): boolean {
  try {
    return BigInt(eventMarketId) % BN254_P === BigInt(conditionId) % BN254_P;
  } catch {
    return false;
  }
}

/**
 * Fetch all BetAuthorized events for a resolved market.
 *
 * Sourced from the proof-relay event index (a single DB-backed read — no per-service getLogs) when
 * available, with a chunked chain scan from the deploy block as the fallback. `market_id` is the
 * SECOND (non-indexed) event parameter, so it CANNOT be a topic filter — we match it in JS.
 */
async function betsForMarket(
  vault: ethers.Contract,
  provider: ethers.JsonRpcProvider,
  conditionId: string,
): Promise<BetAuthorizedRecord[]> {
  const all = await fetchAllBetAuthorized(vault, provider, DEPLOY_BLOCK);
  return all.filter((r) => sameMarket(r.market_id, conditionId));
}

const CTF_ABI = [
  "event ConditionResolution(bytes32 indexed conditionId, address indexed oracle, bytes32 indexed questionId, uint256 outcomeSlotCount, uint256[] payoutNumerators)",
  // Real Gnosis CTF: payoutNumerators is a mapping(bytes32 => uint256[]) — the on-chain getter is
  // the element accessor (conditionId, index), NOT a (conditionId) -> uint256[] array getter (that
  // only existed on MockCTF and reverts against mainnet CTF). Read element-by-index via readNumerators.
  "function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)",
  "function getOutcomeSlotCount(bytes32 conditionId) view returns (uint256)",
  "function payoutDenominator(bytes32 conditionId) view returns (uint256)",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
];

const VAULT_ABI = [
  "function resolveMarket(bytes32 market_id) external",
  "function pendingCredit(bytes32 market_id, uint8 outcome_side) view returns (uint64)",
  "function deployedToPolymarket() view returns (uint256)",
  "function acknowledgePolymarketReturn(uint256 amount) external",
  // M2: outcome_side now included in BetAuthorized event — avoids per-bet betRecords() RPC call.
  // Must match the deployed Vault exactly (FC-14 appended protocolFee, relayFee) so the signature
  // hash / decoding line up with the on-chain event.
  "event BetAuthorized(bytes32 indexed nullifier, bytes32 market_id, bytes32 position_id, uint64 expected_shares, uint256 bet_amount, uint64 price, uint8 outcome_side, bytes32 new_commitment, uint64 protocolFee, uint64 relayFee)",
];

const VAULT_ABI_RESOLVED = ["function marketResolvedAt(bytes32) view returns (uint64)"];

/**
 * Read all payout numerators for a condition from the real Gnosis CTF, which exposes them only as
 * an element accessor `payoutNumerators(conditionId, index)` (no array getter exists on-chain). The
 * loop is bounded by `getOutcomeSlotCount`. The `ctf` contract must be bound to a CTF_ABI that
 * includes both. Returns [] for an unprepared condition (slot count 0).
 */
export async function readNumerators(ctf: ethers.Contract, conditionId: string): Promise<bigint[]> {
  const slotCount: bigint = await ctf.getOutcomeSlotCount(conditionId);
  const out: bigint[] = [];
  for (let i = 0n; i < slotCount; i++) {
    out.push(await ctf.payoutNumerators(conditionId, i));
  }
  return out;
}

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

// VERIFIED against the live CollateralOfframp (0x2957922Eb93258b93368531d39fAcCA3B4dC5854): the
// pUSD→USDC.e call is `unwrap(address _asset, address _to, uint256 _amount)` (selector 0x8cc7104f),
// NOT `withdraw(uint256)` (that was an unverified guess — the same bug class as the onramp, whose
// real selector was `wrap`, not `deposit`; it made this offramp step silently revert). `unwrap`
// pulls `_amount` pUSD from msg.sender (the deposit wallet) and sends `_amount` of `_asset` (USDC.e)
// to `_to` — so we send it straight to the Vault.
const OFFRAMP_ABI = ["function unwrap(address _asset, address _to, uint256 _amount)"];

async function hasVaultShares(
  ctf: ethers.Contract,
  conditionId: string,
  positionIds: string[]
): Promise<boolean> {
  if (!config.depositWalletAddress) return false;
  for (const positionId of positionIds) {
    const bal: bigint = await ctf.balanceOf(config.depositWalletAddress, positionId);
    if (bal > 0n) return true;
  }
  return false;
}

async function collectPositionIds(
  provider: ethers.JsonRpcProvider,
  vaultAddress: string,
  conditionId: string
): Promise<string[]> {
  const vault = new ethers.Contract(vaultAddress, VAULT_ABI, provider);
  const ids = new Set<string>();
  for (const r of await betsForMarket(vault, provider, conditionId)) {
    ids.add(r.position_id);
  }
  return [...ids];
}

/**
 * C2 + H2: all pUSD operations (approve, offramp withdraw, USDC transfer to vault)
 * must originate from the deposit wallet, executed as a single relayer WALLET batch.
 * The DepositWalletExecutor runs the same path against the mock relayer locally and
 * the Polymarket builder relayer in production.
 */
async function offrampPusdToVault(executor: DepositWalletExecutor, amount: bigint): Promise<void> {
  if (!config.offrampAddress || config.offrampAddress === ethers.ZeroAddress) {
    logger.warn("offramp address not set — skipping offramp step");
    return;
  }
  if (amount === 0n) return;
  if (!config.depositWalletAddress) {
    logger.warn("depositWalletAddress not set — skipping offramp step");
    return;
  }

  const erc20Iface = new ethers.Interface(ERC20_ABI);
  const offrampIface = new ethers.Interface(OFFRAMP_ABI);
  const calls: WalletCall[] = [
    // 1) approve offramp to pull pUSD from the deposit wallet
    { target: config.pusdAddress, value: 0n, data: erc20Iface.encodeFunctionData("approve", [config.offrampAddress, amount]) },
    // 2) unwrap — burns the deposit wallet's pUSD and sends USDC.e straight to the Vault
    { target: config.offrampAddress, value: 0n, data: offrampIface.encodeFunctionData("unwrap", [config.usdcAddress, config.vaultContractAddress, amount]) },
  ];

  logger.info({ amount: amount.toString() }, "offramp: approve → unwrap(USDC.e → Vault) via WALLET batch");
  await executor.executeBatch(calls);
  logger.info({ amount: amount.toString() }, "offramp complete — USDC in vault");
}

/**
 * Redeem winning CTF shares from the deposit wallet via the executor (relayer WALLET
 * batch in production, mock relayer locally). M1: index sets derived from outcome count.
 */
async function redeemViaExecutor(
  executor: DepositWalletExecutor,
  conditionId: string,
  numerators: bigint[]
): Promise<boolean> {
  if (!config.depositWalletAddress || !config.pusdAddress) return false;

  const indexSets = Array.from({ length: numerators.length }, (_, i) => 1 << i);
  const ctfIface = new ethers.Interface(CTF_ABI);
  const redeemData = ctfIface.encodeFunctionData("redeemPositions", [
    config.pusdAddress,
    ZERO_BYTES32,
    conditionId,
    indexSets,
  ]);

  try {
    logger.info({ conditionId, indexSets, executor: executor.kind }, "redeem: redeemPositions via deposit-wallet executor");
    await executor.execute({ target: config.ctfAddress, value: 0n, data: redeemData });
    logger.info({ conditionId }, "redeem: redeemPositions confirmed");
    return true;
  } catch (err) {
    logger.warn({ err, conditionId }, "redeem: redeemPositions via executor failed");
    return false;
  }
}

/**
 * Settlement pipeline. STEP 1 (critical): call Vault.resolveMarket so users can settle their notes.
 * STEP 2 (best-effort): redeem winning CTF shares → offramp pUSD → acknowledge returned capital.
 *
 * resolveMarket only READS CTF payouts and is independent of the redemption, so a relayer/redeem
 * failure must NOT prevent it — otherwise a resolved, winning market would never become settleable
 * for users (the symptom that motivated this ordering). STEP 2 runs in its own try/catch and never
 * undoes STEP 1. Idempotent: resolveMarket is skipped if already resolved; redemption is guarded by
 * the deposit wallet's CTF share balance.
 */
export async function runRedemptionPipeline(
  provider: ethers.JsonRpcProvider,
  operatorWallet: ethers.Wallet,
  conditionId: string,
  _eventBlock: number
): Promise<void> {
  const vault = new ethers.Contract(config.vaultContractAddress, VAULT_ABI, operatorWallet);
  const ctf = new ethers.Contract(config.ctfAddress, CTF_ABI, provider);
  const usdcRo = new ethers.Contract(config.usdcAddress, ERC20_ABI, provider);

  const vaultResolved = new ethers.Contract(config.vaultContractAddress, VAULT_ABI_RESOLVED, provider);
  // marketResolvedAt is keyed by the BN254-reduced circuit_key (see Vault._circuitKey), NOT the
  // raw conditionId. Querying with the raw conditionId reads an empty slot and the guard never
  // fires, so the pipeline would redeem again and bounce off resolveMarket's MarketAlreadyResolved
  // revert on every call. Reduce to the circuit_key before the lookup.
  const resolvedAt: bigint = await vaultResolved.marketResolvedAt(toFieldSafe(conditionId));

  const numerators: bigint[] = await readNumerators(ctf, conditionId);
  const denominator: bigint = await ctf.payoutDenominator(conditionId);
  if (denominator === 0n) {
    logger.warn({ conditionId }, "CTF condition not finalized — skipping");
    return;
  }
  if (numerators.every((n) => n === 0n)) {
    logger.info({ conditionId }, "N/A market — skipping resolveMarket");
    return;
  }

  // STEP 1 (critical path): resolve on-chain so users can settle. Idempotent via marketResolvedAt;
  // tolerate a MarketAlreadyResolved race with the event/poll paths.
  if (resolvedAt > 0n) {
    logger.info({ conditionId }, "market already resolved on-chain — skipping resolveMarket");
  } else {
    try {
      logger.info({ conditionId }, "Calling Vault.resolveMarket");
      const tx = await signingLayerNonceManager.send(provider, operatorWallet, (nonce) =>
        vault.resolveMarket(conditionId, { nonce }),
      );
      const receipt = await tx.wait(1);
      logger.info({ conditionId, txHash: receipt?.hash }, "Vault.resolveMarket confirmed");
    } catch (err) {
      // A genuine resolveMarket failure blocks settlement — surface it loudly, but still fall
      // through to attempt collateral redemption (independent concern).
      logger.error({ err, conditionId }, "Vault.resolveMarket failed");
    }
  }

  // STEP 2 (best-effort): redeem winning CTF shares → offramp pUSD → acknowledge returned capital.
  // A failure here leaves the market RESOLVED (users can still settle their notes); the vault may
  // temporarily lack the USDC to pay a withdrawal until redemption is retried. Log, never throw.
  const executor = getDepositWalletExecutor(provider);
  const usdcBefore: bigint = await usdcRo.balanceOf(config.vaultContractAddress);
  const positionIds = await collectPositionIds(provider, config.vaultContractAddress, conditionId);
  const hasShares = await hasVaultShares(ctf, conditionId, positionIds);

  // pUSD actually redeemed (winning shares held × payout); stays 0 if only losing shares are held.
  let redeemedPusd = 0n;

  try {
    if (hasShares) {
      // Offramp EXACTLY the pUSD redeemPositions mints — measured as the deposit wallet's pUSD
      // balance delta across the redeem. Deriving the amount from BetAuthorized expected_shares
      // over-counts: it includes UNFILLED / partially-filled winning orders that never bought
      // CTF shares, so the offramp withdraw would try to pull more pUSD than the wallet holds
      // and revert (MockDepositWallet CallFailed(1) on the pUSD transferFrom). The measured
      // delta is exact and leaves the JIT residual buffer untouched.
      const pusdRo = new ethers.Contract(config.pusdAddress, ERC20_ABI, provider);
      const pusdBefore: bigint = await pusdRo.balanceOf(config.depositWalletAddress);
      await redeemViaExecutor(executor, conditionId, numerators);
      const pusdAfter: bigint = await pusdRo.balanceOf(config.depositWalletAddress);
      redeemedPusd = pusdAfter > pusdBefore ? pusdAfter - pusdBefore : 0n;
      logger.info(
        { conditionId, redeemedPusd: redeemedPusd.toString() },
        "redeem: pUSD minted (deposit-wallet balance delta) → offramp",
      );
      if (redeemedPusd > 0n) {
        await offrampPusdToVault(executor, redeemedPusd);
      } else {
        logger.warn({ conditionId }, "redeemPositions minted no pUSD (no winning shares held) — nothing to offramp");
      }
    } else {
      logger.warn(
        { conditionId },
        "No CTF shares at deposit wallet — no bets filled for this market or order not yet settled"
      );
      // No mockInfuseVaultUsdc: that shortcut masked the real settlement bug (C2/C5).
      // If shares exist after the fix but this branch is still hit, it is a genuine no-op market.
    }

    const usdcAfter: bigint = await usdcRo.balanceOf(config.vaultContractAddress);
    // Only an error if we actually redeemed pUSD (winning shares) but the vault didn't receive
    // the USDC. Holding only losing shares legitimately returns nothing, so don't false-alarm.
    if (redeemedPusd > 0n && usdcAfter <= usdcBefore) {
      throw new Error(
        `Vault USDC did not increase after redemption (before=${usdcBefore} after=${usdcAfter})`
      );
    }

    // Acknowledge returned capital so deployedToPolymarket decrements. Use the measured
    // USDC delta (robust to rounding), clamped to the currently-deployed amount. The
    // residual buffer left by no-fills is intentionally NOT acknowledged here.
    const returned = usdcAfter - usdcBefore;
    if (returned > 0n) {
      const deployed: bigint = await vault.deployedToPolymarket();
      const ack = returned < deployed ? returned : deployed;
      if (ack > 0n) {
        const ackTx = await signingLayerNonceManager.send(provider, operatorWallet, (nonce) =>
          vault.acknowledgePolymarketReturn(ack, { nonce }),
        );
        await ackTx.wait(1);
        logger.info({ ack: ack.toString() }, "acknowledgePolymarketReturn confirmed");
      }
    }
  } catch (err) {
    // Collateral redemption failed — the market is already resolved on-chain (STEP 1), so users can
    // still settle. The vault may lack USDC to fund a withdrawal until redemption is retried.
    logger.error(
      { err, conditionId },
      "collateral redemption failed (market resolved on-chain — users can settle; retry redemption to fund withdrawals)",
    );
  }
}
