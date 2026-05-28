import { ethers } from "ethers";
import pino from "pino";
import { config } from "./config";
import { signingLayerNonceManager } from "./nonceManager";

const logger = pino({ name: "redemption-pipeline" });

const ZERO_BYTES32 = "0x" + "00".repeat(32);

const CTF_ABI = [
  "event ConditionResolution(bytes32 indexed conditionId, address indexed oracle, bytes32 indexed questionId, uint256 outcomeSlotCount, uint256[] payoutNumerators)",
  "function payoutNumerators(bytes32 conditionId) view returns (uint256[])",
  "function payoutDenominator(bytes32 conditionId) view returns (uint256)",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
];

const VAULT_ABI = [
  "function resolveMarket(bytes32 market_id) external",
  "function pendingCredit(bytes32 market_id, uint8 outcome_side) view returns (uint64)",
  // M2: outcome_side now included in BetAuthorized event — avoids per-bet betRecords() RPC call.
  "event BetAuthorized(bytes32 indexed nullifier, bytes32 market_id, bytes32 position_id, uint64 expected_shares, uint256 bet_amount, uint64 price, uint8 outcome_side, bytes32 new_commitment)",
];

const VAULT_ABI_RESOLVED = ["function marketResolvedAt(bytes32) view returns (uint64)"];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

const OFFRAMP_ABI = ["function withdraw(uint256 amount) external"];

/**
 * Return a signer for the deposit wallet.
 * In local dev: uses DEPOSIT_WALLET_KEY to sign transactions directly.
 * In production: wallet actions must go through the Polymarket relayer WALLET batch
 * (see BUG-H2 in collateral-flow-audit.md). The fallback to operatorWallet is intentional
 * only as a last-resort guard to surface a clear error rather than silently no-op.
 */
function depositWalletSigner(
  provider: ethers.JsonRpcProvider,
  operatorWallet: ethers.Wallet
): ethers.Wallet {
  if (config.depositWalletKey) {
    return new ethers.Wallet(config.depositWalletKey, provider);
  }
  // Production path: relayer WALLET batch not yet implemented. Log a clear error so it's
  // not silently skipped. Callers should gate on this before proceeding.
  logger.error(
    "DEPOSIT_WALLET_KEY not set and relayer client not configured — " +
    "deposit wallet transactions will be sent from operator EOA (WRONG in production). " +
    "Set DEPOSIT_WALLET_KEY for local dev or wire the Polymarket relayer for production."
  );
  return operatorWallet;
}

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
  const filter = vault.filters.BetAuthorized(null, conditionId);
  const logs = await vault.queryFilter(filter, 0, "latest");
  const ids = new Set<string>();
  for (const log of logs) {
    const parsed = vault.interface.parseLog({ topics: log.topics as string[], data: log.data });
    if (parsed) ids.add(parsed.args.position_id as string);
  }
  return [...ids];
}

/**
 * C3 fix: sum expected_shares for winning-side FILLED bets only.
 * This is the pUSD the deposit wallet will receive from redeemPositions.
 * Uses outcome_side from the BetAuthorized event (M2 fix) to avoid per-bet RPC calls.
 */
async function computeRedemptionAmount(
  provider: ethers.JsonRpcProvider,
  vaultAddress: string,
  conditionId: string,
  winningSide: number
): Promise<bigint> {
  const vault = new ethers.Contract(vaultAddress, VAULT_ABI, provider);
  const filter = vault.filters.BetAuthorized(null, conditionId);
  const logs = await vault.queryFilter(filter, 0, "latest");
  let total = 0n;
  for (const log of logs) {
    const parsed = vault.interface.parseLog({ topics: log.topics as string[], data: log.data });
    if (!parsed) continue;
    // Only count bets on the winning side.
    if (Number(parsed.args.outcome_side) !== winningSide) continue;
    total += parsed.args.expected_shares as bigint;
  }
  return total;
}

/**
 * C2 + H2 fix: all pUSD operations (approve, offramp withdraw, USDC transfer to vault)
 * must originate from the deposit wallet, not the operator EOA.
 *
 * Local dev: uses DEPOSIT_WALLET_KEY to sign directly.
 * Production: must use Polymarket relayer WALLET batch (not yet implemented — see H2).
 */
async function offrampPusdToVault(
  provider: ethers.JsonRpcProvider,
  operatorWallet: ethers.Wallet,
  amount: bigint
): Promise<void> {
  if (!config.offrampAddress || config.offrampAddress === ethers.ZeroAddress) {
    logger.warn("offramp address not set — skipping offramp step");
    return;
  }
  if (amount === 0n) return;
  if (!config.depositWalletAddress) {
    logger.warn("depositWalletAddress not set — skipping offramp step");
    return;
  }

  const dwSigner = depositWalletSigner(provider, operatorWallet);
  let dwNonce = await provider.getTransactionCount(dwSigner.address);

  const pusd = new ethers.Contract(config.pusdAddress, ERC20_ABI, dwSigner);
  const offramp = new ethers.Contract(config.offrampAddress, OFFRAMP_ABI, dwSigner);
  const usdc = new ethers.Contract(config.usdcAddress, ERC20_ABI, dwSigner);

  // Step 1: approve offramp to spend pUSD from depositWallet
  logger.info({ amount: amount.toString() }, "offramp step 1: approve pUSD from depositWallet");
  await (await pusd.approve(config.offrampAddress, amount, { nonce: dwNonce++ })).wait(1);

  // Step 2: call offramp.withdraw — burns pUSD, sends USDC to depositWallet
  logger.info({ amount: amount.toString() }, "offramp step 2: withdraw → depositWallet receives USDC");
  await (await offramp.withdraw(amount, { nonce: dwNonce++ })).wait(1);

  // Step 3: transfer USDC from depositWallet to Vault
  logger.info({ amount: amount.toString() }, "offramp step 3: transfer USDC to Vault");
  const tx = await usdc.transfer(config.vaultContractAddress, amount, { nonce: dwNonce++ });
  await tx.wait(1);

  logger.info({ amount: amount.toString(), txHash: tx.hash }, "offramp complete — USDC in vault");
}

/**
 * M1 fix: derive index sets from the number of outcome slots rather than hardcoding [1, 2].
 * Direct on-chain redemption via deposit wallet — Q18 fallback for local dev.
 * In production this must be submitted as a relayer WALLET batch (see BUG-H2).
 */
async function tryDirectDepositWalletRedeem(
  provider: ethers.JsonRpcProvider,
  operatorWallet: ethers.Wallet,
  conditionId: string,
  numerators: bigint[]
): Promise<boolean> {
  if (!config.depositWalletAddress || !config.pusdAddress) return false;

  // Derive index sets from outcome count — fixes M1 hardcoded [1, 2].
  const indexSets = Array.from({ length: numerators.length }, (_, i) => 1 << i);

  const ctfIface = new ethers.Interface(CTF_ABI);
  const redeemData = ctfIface.encodeFunctionData("redeemPositions", [
    config.pusdAddress,
    ZERO_BYTES32,
    conditionId,
    indexSets,
  ]);

  const dwSigner = depositWalletSigner(provider, operatorWallet);

  try {
    logger.warn({ conditionId, indexSets }, "B3 fallback: calling redeemPositions from depositWallet");

    if (config.depositWalletKey) {
      // Local dev: deposit wallet is an EOA — call CTF directly, no execute() wrapper needed.
      const ctf = new ethers.Contract(config.ctfAddress, CTF_ABI, dwSigner);
      const dwNonce = await provider.getTransactionCount(dwSigner.address);
      const tx = await ctf.redeemPositions(
        config.pusdAddress, ZERO_BYTES32, conditionId, indexSets, { nonce: dwNonce }
      );
      await tx.wait(1);
      logger.info({ conditionId, txHash: tx.hash }, "redeemPositions confirmed from depositWallet EOA");
    } else {
      // Production: deposit wallet is an ERC-1967 proxy — must use relayer WALLET batch.
      // TODO (H2): submit via @polymarket/builder-relayer-client instead.
      // For now attempt the legacy execute() interface and log clearly if it fails.
      const depositWalletContract = new ethers.Contract(
        config.depositWalletAddress,
        ["function execute(address to, uint256 value, bytes calldata data) external returns (bytes memory)"],
        dwSigner
      );
      const dwNonce = await provider.getTransactionCount(dwSigner.address);
      const tx = await depositWalletContract.execute(config.ctfAddress, 0, redeemData, { nonce: dwNonce });
      await tx.wait(1);
      logger.info({ conditionId, txHash: tx.hash }, "B3 fallback: execute confirmed");
    }
    return true;
  } catch (err) {
    logger.warn({ err, conditionId }, "B3 fallback: redeemPositions from depositWallet failed");
    return false;
  }
}

async function runRelayerRedeemWithTimeout(
  provider: ethers.JsonRpcProvider,
  wallet: ethers.Wallet,
  conditionId: string,
  startedBlock: number,
  numerators: bigint[]
): Promise<boolean> {
  // Relayer integration placeholder — production uses @polymarket/builder-relayer-client.
  const current = await provider.getBlockNumber();
  if (current - startedBlock >= config.redemptionRelayTimeoutBlocks) {
    return tryDirectDepositWalletRedeem(provider, wallet, conditionId, numerators);
  }
  logger.info({ conditionId }, "Relayer redeem not configured — will use direct fallback on next retry");
  return false;
}

/**
 * Full B1 pipeline: redeem CTF → offramp pUSD → resolveMarket.
 * Idempotent via Vault.marketResolvedAt guard.
 */
export async function runRedemptionPipeline(
  provider: ethers.JsonRpcProvider,
  operatorWallet: ethers.Wallet,
  conditionId: string,
  eventBlock: number
): Promise<void> {
  const vault = new ethers.Contract(config.vaultContractAddress, VAULT_ABI, operatorWallet);
  const ctf = new ethers.Contract(config.ctfAddress, CTF_ABI, provider);
  const usdcRo = new ethers.Contract(config.usdcAddress, ERC20_ABI, provider);

  const vaultResolved = new ethers.Contract(config.vaultContractAddress, VAULT_ABI_RESOLVED, provider);
  const resolvedAt: bigint = await vaultResolved.marketResolvedAt(conditionId);
  if (resolvedAt > 0n) {
    logger.info({ conditionId }, "Market already resolved in Vault — skipping pipeline");
    return;
  }

  const numerators: bigint[] = await ctf.payoutNumerators(conditionId);
  const denominator: bigint = await ctf.payoutDenominator(conditionId);
  if (denominator === 0n) {
    logger.warn({ conditionId }, "CTF condition not finalized — skipping");
    return;
  }
  if (numerators.every((n) => n === 0n)) {
    logger.info({ conditionId }, "N/A market — skipping resolveMarket");
    return;
  }

  // Determine winning outcome side: YES=0 if numerators[0]>0, else NO=1.
  const winningSide = numerators[0] > 0n ? 0 : 1;

  const usdcBefore: bigint = await usdcRo.balanceOf(config.vaultContractAddress);
  const positionIds = await collectPositionIds(provider, config.vaultContractAddress, conditionId);
  const hasShares = await hasVaultShares(ctf, conditionId, positionIds);

  try {
    if (hasShares) {
      const redeemed = await runRelayerRedeemWithTimeout(provider, operatorWallet, conditionId, eventBlock, numerators);
      if (!redeemed) {
        await tryDirectDepositWalletRedeem(provider, operatorWallet, conditionId, numerators);
      }

      // C3 fix: use expected_shares of winning-side bets, not bet_amount of all bets.
      const redemptionAmount = await computeRedemptionAmount(
        provider,
        config.vaultContractAddress,
        conditionId,
        winningSide
      );
      await offrampPusdToVault(provider, operatorWallet, redemptionAmount);
    } else {
      logger.warn(
        { conditionId },
        "No CTF shares at deposit wallet — no bets filled for this market or order not yet settled"
      );
      // No mockInfuseVaultUsdc: that shortcut masked the real settlement bug (C2/C5).
      // If shares exist after the fix but this branch is still hit, it is a genuine no-op market.
    }

    const usdcAfter: bigint = await usdcRo.balanceOf(config.vaultContractAddress);
    if (usdcAfter <= usdcBefore && hasShares) {
      throw new Error(
        `Vault USDC did not increase after redemption (before=${usdcBefore} after=${usdcAfter})`
      );
    }

    logger.info({ conditionId }, "Calling Vault.resolveMarket");
    const tx = await signingLayerNonceManager.send(provider, operatorWallet, (nonce) =>
      vault.resolveMarket(conditionId, { nonce }),
    );
    const receipt = await tx.wait(1);
    logger.info({ conditionId, txHash: receipt?.hash }, "Vault.resolveMarket confirmed");
  } catch (err) {
    logger.error({ err, conditionId }, "Redemption pipeline failed — halting (no silent retry)");
    throw err;
  }
}
