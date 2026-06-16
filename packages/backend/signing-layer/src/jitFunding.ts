import { ethers } from "ethers";
import pino from "pino";
import { config } from "./config";
import { signingLayerNonceManager } from "./nonceManager";
import { getDepositWalletExecutor, wrapUsdcToPusd } from "./depositWalletExecutor";

const logger = pino({ name: "jit-funding" });

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
const VAULT_ABI = ["function fundPolymarketWallet(uint256 amount) external"];

/**
 * Option-3 (JIT) collateral deployment.
 *
 * Before each bet is submitted to the CLOB, ensure the Polymarket deposit wallet
 * holds at least `betAmount` pUSD of buying power. Nothing is pre-deployed at
 * deposit time — the deposit wallet is funded just-in-time, per bet, by converting
 * the exact shortfall of vault USDC → pUSD via `Vault.fundPolymarketWallet`.
 *
 * Residual-buffer semantics (the deliberate stepping stone toward Option 4):
 * we never sweep pUSD back on a FOK no-fill, so the deposit wallet accumulates an
 * idle pUSD buffer equal to the unfilled volume. The balance check below reuses
 * that residual first and only onramps the shortfall, so the steady state drifts
 * toward a self-provisioned base buffer without any per-bet sweep-back.
 *
 * Accounting: `Vault.deployedToPolymarket` grows with each top-up and is only
 * decremented at settlement via `acknowledgePolymarketReturn`. With the residual
 * buffer it intentionally overstates idle exposure; the SEC-007 `deploymentCap`
 * is the hard ceiling that bounds it.
 */

// Serialize JIT funding so two near-simultaneous bets do not both read a stale
// deposit-wallet balance and double-fund (or under-fund). Each call awaits the
// previous one; on-chain nonce safety is handled by signingLayerNonceManager.
let fundingChain: Promise<unknown> = Promise.resolve();

/**
 * Run `fn` serialized on the shared funding mutex. BOTH per-bet JIT funding
 * (ensureDepositWalletFunded) and the proactive buffer manager (bufferManager.ts) enqueue here, so
 * a buffer top-up and a JIT top-up can never interleave — otherwise two near-simultaneous reads of
 * the deposit-wallet balance would both see a shortfall and double-fund (or reuse a nonce). The
 * mutex is never poisoned: a rejecting `fn` still advances the queue for the next caller.
 */
export async function runOnFundingChain<T>(fn: () => Promise<T>): Promise<T> {
  const run = fundingChain.then(fn);
  fundingChain = run.catch(() => undefined);
  return run;
}

// C3: optional hook fired (fire-and-forget) after every JIT funding event, so the buffer manager can
// re-check the base buffer around betting activity instead of polling the balance on a tight loop.
// Registered by bufferManager.startBufferManager; a no-op when the buffer manager is disabled.
let _afterFunding: (() => void) | null = null;
export function setAfterFundingHook(cb: () => void): void {
  _afterFunding = cb;
}

export async function ensureDepositWalletFunded(
  provider: ethers.JsonRpcProvider,
  operatorWallet: ethers.Wallet,
  betAmount: bigint,
): Promise<boolean> {
  const funded = await runOnFundingChain(() => fundOnce(provider, operatorWallet, betAmount)).catch((err) => {
    logger.error({ err: String(err) }, "JIT funding: unexpected error — treating as unfunded");
    return false;
  });
  // Nudge the buffer check AFTER the funding chain settles (never awaited → no re-entrant enqueue).
  if (_afterFunding) { try { _afterFunding(); } catch { /* buffer nudge must never break a bet */ } }
  return funded;
}

async function fundOnce(
  provider: ethers.JsonRpcProvider,
  operatorWallet: ethers.Wallet,
  betAmount: bigint,
): Promise<boolean> {
  if (!config.pusdAddress || !config.depositWalletAddress || !config.onrampAddress) {
    logger.error("JIT funding: PUSD_ADDRESS / DEPOSIT_WALLET_ADDRESS / ONRAMP_ADDRESS not set — cannot fund");
    return false;
  }
  try {
    // Polymarket trades in pUSD, so the deposit wallet's buying power is its pUSD balance.
    // The vault funds in USDC (it can't hold pUSD), then the deposit wallet wraps USDC→pUSD
    // via the onramp. The residual buffer is therefore pUSD left from a prior no-fill.
    const pusd = new ethers.Contract(config.pusdAddress, ERC20_ABI, provider);
    const balance = (await pusd.balanceOf(config.depositWalletAddress)) as bigint;

    if (balance >= betAmount) {
      logger.info(
        { balance: balance.toString(), betAmount: betAmount.toString() },
        "JIT funding: residual pUSD buffer already covers bet — reusing (no top-up)",
      );
      return true;
    }

    const shortfall = betAmount - balance;
    // (1) Move the USDC shortfall vault → deposit wallet (USDC, since the vault can't hold pUSD).
    const vault = new ethers.Contract(config.vaultContractAddress, VAULT_ABI, operatorWallet);
    logger.info(
      { pusdBalance: balance.toString(), betAmount: betAmount.toString(), shortfall: shortfall.toString() },
      "JIT funding: topping up deposit wallet via fundPolymarketWallet (USDC)",
    );
    const tx = await signingLayerNonceManager.send(provider, operatorWallet, (nonce) =>
      (vault as ethers.Contract & {
        fundPolymarketWallet: (a: bigint, o: ethers.Overrides) => Promise<ethers.TransactionResponse>;
      }).fundPolymarketWallet(shortfall, { nonce }),
    );
    await tx.wait(1);
    logger.info({ shortfall: shortfall.toString(), txHash: tx.hash }, "JIT funding: fundPolymarketWallet confirmed (USDC in deposit wallet)");

    // (2) Deposit wallet wraps the USDC shortfall → pUSD via the onramp (mints pUSD to itself).
    const executor = getDepositWalletExecutor(provider);
    await wrapUsdcToPusd(executor, shortfall);
    logger.info({ shortfall: shortfall.toString() }, "JIT funding: USDC→pUSD wrapped in deposit wallet");
    return true;
  } catch (err) {
    // DeployCapExceeded / InsufficientVaultLiquidity / any revert: never throw and
    // never silently proceed. The caller reports the bet as a FOK failure so the
    // user reclaims their note via betCancellationCredit (recoverable, not a debit).
    logger.error(
      { err: String(err), betAmount: betAmount.toString() },
      "JIT funding failed (cap / liquidity / other) — bet will be reported as FOK failure (recoverable)",
    );
    return false;
  }
}
