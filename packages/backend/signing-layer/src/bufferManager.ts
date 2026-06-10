import { ethers } from "ethers";
import pino from "pino";
import { config } from "./config";
import { signingLayerNonceManager } from "./nonceManager";
import { runOnFundingChain } from "./jitFunding";
import { getDepositWalletExecutor, wrapUsdcToPusd } from "./depositWalletExecutor";

const logger = pino({ name: "buffer-manager" });

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
const VAULT_ABI = ["function fundPolymarketWallet(uint256 amount) external"];

/**
 * FC-6 / Option 4: proactive base-buffer manager.
 *
 * Keeps the Polymarket deposit wallet pre-funded with pUSD up to a target, so the COMMON bet
 * spends from an already-indexed buffer and needs NO per-bet USDC→pUSD wrap — eliminating the
 * Polymarket-backend indexing lag that otherwise rejects JIT-funded orders (and removing the
 * downsizing those rejections force, which is the root of the FOK/FAK fill divergence). Per-bet
 * JIT (jitFunding.ts) remains the OVERFLOW path for bursts that outrun the buffer.
 *
 * Each tick (the read-decide-fund runs on the SHARED funding mutex, so a buffer top-up and a
 * per-bet JIT top-up never both read the same stale balance and double-fund / reuse a nonce):
 *   - read the deposit wallet's pUSD balance;
 *   - if balance >= lowWater → no-op;
 *   - else top up to `target`: Vault.fundPolymarketWallet(target − balance) (USDC → deposit wallet)
 *     then wrapUsdcToPusd(shortfall) (USDC → pUSD). Bounded on-chain by deploymentCap; a
 *     DeployCapExceeded / InsufficientVaultLiquidity revert is caught and logged (never crashes).
 *
 * Disabled when BUFFER_LOW_WATER_USDC / BUFFER_TARGET_USDC are 0/unset (safe default). Sweep-DOWN
 * of excess residual is out of scope for v1 (the buffer drains via settlement offramp; the cap
 * bounds it) — see docs/future-changes.md FC-6/FC-7.
 */

let _timer: ReturnType<typeof setInterval> | null = null;
let _running = false; // re-entrancy guard: skip a tick if the previous one is still in flight

export function startBufferManager(provider: ethers.JsonRpcProvider, operatorWallet: ethers.Wallet): void {
  const low = config.bufferLowWaterUsdc;
  const target = config.bufferTargetUsdc;
  const high = config.bufferHighWaterUsdc;

  if (low <= 0n || target <= 0n) {
    logger.info("buffer manager disabled (BUFFER_LOW_WATER_USDC / BUFFER_TARGET_USDC unset or 0)");
    return;
  }
  if (!config.pusdAddress || !config.depositWalletAddress) {
    logger.error("buffer manager: PUSD_ADDRESS / DEPOSIT_WALLET_ADDRESS not set — not starting");
    return;
  }
  if (target < low) {
    logger.warn(
      { low: low.toString(), target: target.toString() },
      "buffer manager: target < low-water — clamping target up to low-water",
    );
  }
  if (high > 0n && target > high) {
    logger.warn(
      { target: target.toString(), high: high.toString() },
      "buffer manager: target > high-water — check config (target should sit between low and high)",
    );
  }

  const tick = async () => {
    if (_running) return;
    _running = true;
    try {
      await topUpOnce(provider, operatorWallet);
    } catch (err) {
      // DeployCapExceeded / InsufficientVaultLiquidity / any revert or RPC error — never crash the
      // signing layer; the next tick retries once the cap/liquidity recovers.
      logger.warn({ err: String(err) }, "buffer manager tick failed (continuing)");
    } finally {
      _running = false;
    }
  };

  void tick(); // run once immediately at startup
  _timer = setInterval(() => void tick(), config.bufferManagerPollMs);
  logger.info(
    { low: low.toString(), target: target.toString(), pollMs: config.bufferManagerPollMs },
    "buffer manager started (FC-6 / Option 4 base buffer)",
  );
}

export function stopBufferManager(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

async function topUpOnce(provider: ethers.JsonRpcProvider, operatorWallet: ethers.Wallet): Promise<void> {
  const low = config.bufferLowWaterUsdc;
  const target = config.bufferTargetUsdc < low ? low : config.bufferTargetUsdc;

  // Read-decide-fund ALL inside the shared mutex so a concurrent JIT top-up can't change the
  // balance between our read and our decision (which would double-fund).
  await runOnFundingChain(async () => {
    const pusd = new ethers.Contract(config.pusdAddress, ERC20_ABI, provider);
    const balance = (await pusd.balanceOf(config.depositWalletAddress)) as bigint;
    if (balance >= low) {
      logger.debug(
        { balance: balance.toString(), low: low.toString() },
        "buffer manager: pUSD balance >= low-water — no top-up",
      );
      return;
    }

    const topUp = target - balance; // target >= low > balance ⇒ topUp > 0
    logger.info(
      { balance: balance.toString(), low: low.toString(), target: target.toString(), topUp: topUp.toString() },
      "buffer manager: below low-water — topping up to target",
    );

    // (1) Vault USDC → deposit wallet (the vault can't hold pUSD).
    const vault = new ethers.Contract(config.vaultContractAddress, VAULT_ABI, operatorWallet);
    const tx = await signingLayerNonceManager.send(provider, operatorWallet, (nonce) =>
      (vault as ethers.Contract & {
        fundPolymarketWallet: (a: bigint, o: ethers.Overrides) => Promise<ethers.TransactionResponse>;
      }).fundPolymarketWallet(topUp, { nonce }),
    );
    await tx.wait(1);
    logger.info({ topUp: topUp.toString(), txHash: tx.hash }, "buffer manager: fundPolymarketWallet confirmed (USDC)");

    // (2) Deposit wallet wraps USDC → pUSD (indexed buying power for upcoming bets).
    const executor = getDepositWalletExecutor(provider);
    await wrapUsdcToPusd(executor, topUp);
    logger.info({ topUp: topUp.toString() }, "buffer manager: USDC→pUSD wrapped into base buffer");
  });
}
