import { ethers } from "ethers";
import pino from "pino";

const logger = pino({ name: "nonce-manager" });

const NONCE_ERROR_PATTERNS = ["nonce too low", "nonce too high", "replacement underpriced", "NONCE_EXPIRED", "already known", "invalid nonce"];

/**
 * Global nonce manager for the signing-layer operator wallet.
 *
 * All on-chain transactions from the signing layer (resolveMarket, offramp,
 * redeemPositions) must go through this manager to prevent stale-nonce drops
 * under concurrent or rapid sequential submissions.
 *
 * Usage:
 *   const tx = await signingLayerNonceManager.send(provider, wallet, (nonce) =>
 *     contract.someFunction(arg, { nonce })
 *   );
 */
class NonceManager {
  private nonce: number | null = null;
  private lastSeenBlock = 0;

  async getAndIncrement(provider: ethers.JsonRpcProvider, address: string): Promise<number> {
    if (this.nonce === null) {
      this.nonce = await provider.getTransactionCount(address, "pending");
      logger.debug({ address, nonce: this.nonce }, "nonce-manager: seeded from pending count");
    }
    return this.nonce++;
  }

  decrement(): void {
    if (this.nonce !== null && this.nonce > 0) this.nonce--;
  }

  reset(): void {
    this.nonce = null;
    logger.debug("nonce-manager: reset");
  }

  async checkForChainReset(provider: ethers.JsonRpcProvider): Promise<void> {
    if (process.env.NODE_ENV === "production") return;
    try {
      const current = await provider.getBlockNumber();
      if (current < this.lastSeenBlock) {
        logger.warn({ current, lastSeen: this.lastSeenBlock }, "nonce-manager: chain reset detected — resetting nonce");
        this.reset();
      }
      this.lastSeenBlock = current;
    } catch {
      // Non-fatal: skip the check if RPC is unavailable
    }
  }

  async send(
    provider: ethers.JsonRpcProvider,
    wallet: ethers.Wallet,
    fn: (nonce: number) => Promise<ethers.TransactionResponse>,
  ): Promise<ethers.TransactionResponse> {
    const nonce = await this.getAndIncrement(provider, wallet.address);
    try {
      return await fn(nonce);
    } catch (err) {
      const msg = String(err).toLowerCase();
      const isNonceError = NONCE_ERROR_PATTERNS.some((p) => msg.includes(p.toLowerCase()));
      if (isNonceError) {
        logger.warn({ nonce, err: String(err) }, "nonce-manager: nonce error — resetting and retrying once");
        this.reset();
        const freshNonce = await this.getAndIncrement(provider, wallet.address);
        return fn(freshNonce);
      }
      // tx was never broadcast (e.g. estimateGas failed) — return the nonce slot
      this.decrement();
      throw err;
    }
  }
}

export const signingLayerNonceManager = new NonceManager();
