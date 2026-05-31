import { ethers } from "ethers";
import pino from "pino";

const logger = pino({ name: "relayer", level: "debug" });

const VAULT_ABI = [
  "function authorizeBet(bytes calldata proof, tuple(bytes32 merkle_root, bytes32 nullifier, bytes32 new_commitment, uint64 bet_amount, uint64 price, uint64 expected_shares, bytes32 market_id, uint8 outcome_side, bytes32 position_id) calldata inputs)",
  "function creditSettlement(bytes calldata proof, tuple(bytes32 merkle_root, bytes32 nullifier, bytes32 new_commitment, bytes32 nullifier_of_bet, bytes32 market_id, uint64 total_credit) calldata inputs)",
  "function withdraw(bytes calldata proof, tuple(bytes32 merkle_root, bytes32 nullifier, uint64 withdrawal_amount, bytes32 recipient_hash, bytes32 new_commitment) calldata inputs, address recipientAddress)",
  "function betCancellationCredit(bytes calldata proof, tuple(bytes32 merkle_root, bytes32 nullifier, bytes32 new_commitment, bytes32 nullifier_of_bet) calldata inputs)",
  "function naCancellationCredit(bytes calldata proof, tuple(bytes32 merkle_root, bytes32 nullifier, bytes32 new_commitment, bytes32 nullifier_of_bet, bytes32 market_id) calldata inputs)",
  "function closePosition(bytes calldata proof, tuple(bytes32 merkle_root, bytes32 nullifier, bytes32 new_commitment, bytes32 nullifier_of_bet) calldata inputs)",
  "function partialFillCredit(bytes calldata proof, tuple(bytes32 merkle_root, bytes32 nullifier, bytes32 new_commitment, bytes32 nullifier_of_bet) calldata inputs)",
];

// ── Nonce manager ─────────────────────────────────────────────────────────────
//
// Fetching the nonce from eth_getTransactionCount("latest") on each call
// returns only confirmed-transaction counts. Under concurrent submissions this
// causes the second request to reuse the same nonce as the first, dropping one
// of the two transactions. We maintain a monotonically-incrementing in-memory
// counter, seeding from "pending" on first use, and reset on any nonce error.

class NonceManager {
  private nonce: number | null = null;
  private lastSeenBlock = 0;

  async getAndIncrement(provider: ethers.JsonRpcProvider, address: string): Promise<number> {
    if (this.nonce === null) {
      this.nonce = await provider.getTransactionCount(address, "pending");
    }
    return this.nonce++;
  }

  // Call when a tx was never broadcast (e.g. estimateGas failed) so the nonce
  // slot can be reused by the next call instead of leaving a gap.
  decrement(): void {
    if (this.nonce !== null && this.nonce > 0) this.nonce--;
  }

  reset(): void {
    this.nonce = null;
  }

  async checkForChainReset(provider: ethers.JsonRpcProvider): Promise<void> {
    if (process.env.NODE_ENV === "production") return;
    try {
      const current = await provider.getBlockNumber();
      if (current < this.lastSeenBlock) {
        logger.warn({ current, lastSeen: this.lastSeenBlock }, "relayer: chain reset detected — resetting nonce");
        this.reset();
      }
      this.lastSeenBlock = current;
    } catch {
      // Non-fatal: if the RPC is unavailable we skip the check
    }
  }
}

const nonceManager = new NonceManager();

let wallet: ethers.Wallet;
let vault: ethers.Contract;
let _provider: ethers.JsonRpcProvider;

export function initRelayer(relayerKey: string, vaultAddress: string, provider: ethers.JsonRpcProvider): void {
  wallet = new ethers.Wallet(relayerKey, provider);
  vault = new ethers.Contract(vaultAddress, VAULT_ABI, wallet);
  _provider = provider;
  nonceManager.reset();
  void nonceManager.checkForChainReset(provider);
  logger.info({ relayerAddress: wallet.address, vaultAddress }, "relayer:init");
}

// ── Nonce-aware tx sender ─────────────────────────────────────────────────────

const NONCE_ERROR_PATTERNS = ["nonce too low", "nonce too high", "replacement underpriced", "NONCE_EXPIRED", "already known", "invalid nonce"];

async function sendWithNonce(
  fn: (nonce: number) => Promise<ethers.TransactionResponse>,
): Promise<ethers.TransactionResponse> {
  const nonce = await nonceManager.getAndIncrement(_provider, wallet.address);
  try {
    return await fn(nonce);
  } catch (err) {
    const msg = String(err).toLowerCase();
    const isNonceError = NONCE_ERROR_PATTERNS.some((p) => msg.includes(p.toLowerCase()));
    if (isNonceError) {
      logger.warn({ nonce, err: String(err) }, "relayer: nonce error — resetting and retrying once");
      nonceManager.reset();
      const freshNonce = await nonceManager.getAndIncrement(_provider, wallet.address);
      return fn(freshNonce);
    }
    // The tx was never broadcast (e.g. estimateGas reverted). Return the nonce
    // so the next call can reuse it instead of leaving a gap in the mempool.
    nonceManager.decrement();
    throw err;
  }
}

function proofBytes(proof: string): number {
  const hex = proof.startsWith("0x") ? proof.slice(2) : proof;
  return Math.floor(hex.length / 2);
}

function fingerprint(proof: string): string {
  const hex = proof.startsWith("0x") ? proof.slice(2) : proof;
  return hex.length > 16 ? `${hex.slice(0, 8)}…${hex.slice(-8)}` : hex;
}

/** Fire-and-forget: wait for receipt and log gas + block number. */
function trackReceipt(label: string, tx: ethers.TransactionResponse, startMs: number): void {
  void tx.wait(1).then((receipt) => {
    logger.info({
      event: `${label}:confirmed`,
      txHash: tx.hash,
      gasUsed: receipt?.gasUsed?.toString() ?? "unknown",
      gasPrice: tx.gasPrice?.toString() ?? "unknown",
      gasCostWei: receipt && tx.gasPrice
        ? (receipt.gasUsed * tx.gasPrice).toString()
        : "unknown",
      blockNumber: receipt?.blockNumber ?? null,
      duration_ms: Date.now() - startMs,
    }, `${label}:confirmed`);
  }).catch((err: unknown) => {
    logger.warn({ event: `${label}:receipt_error`, txHash: tx.hash, err: String(err) }, `${label}:receipt_error`);
  });
}

export async function relayAuthorizeBet(proof: string, inputs: unknown): Promise<string> {
  const start = Date.now();
  const inp = inputs as Record<string, unknown>;
  logger.info({
    event: "relay:authorizeBet:start",
    proof_bytes: proofBytes(proof),
    proof_fingerprint: fingerprint(proof),
    nullifier_prefix: typeof inp["nullifier"] === "string" ? (inp["nullifier"] as string).slice(0, 10) : undefined,
  }, "relay:authorizeBet:start");

  const tx = await sendWithNonce((nonce) =>
    (vault as ethers.Contract & {
      authorizeBet: (p: string, i: unknown, o: ethers.Overrides) => Promise<ethers.TransactionResponse>
    }).authorizeBet(proof, inputs, { nonce }),
  );

  logger.info({ event: "relay:authorizeBet:tx_sent", txHash: tx.hash, nonce: tx.nonce, elapsed_ms: Date.now() - start }, "relay:authorizeBet:tx_sent");
  trackReceipt("relay:authorizeBet", tx, start);
  return tx.hash;
}

export async function relayCreditSettlement(proof: string, inputs: unknown): Promise<string> {
  const start = Date.now();
  const inp = inputs as Record<string, unknown>;
  logger.info({
    event: "relay:creditSettlement:start",
    proof_bytes: proofBytes(proof),
    proof_fingerprint: fingerprint(proof),
    nullifier_prefix: typeof inp["nullifier"] === "string" ? (inp["nullifier"] as string).slice(0, 10) : undefined,
  }, "relay:creditSettlement:start");

  const tx = await sendWithNonce((nonce) =>
    (vault as ethers.Contract & {
      creditSettlement: (p: string, i: unknown, o: ethers.Overrides) => Promise<ethers.TransactionResponse>
    }).creditSettlement(proof, inputs, { nonce }),
  );

  logger.info({ event: "relay:creditSettlement:tx_sent", txHash: tx.hash, nonce: tx.nonce, elapsed_ms: Date.now() - start }, "relay:creditSettlement:tx_sent");
  trackReceipt("relay:creditSettlement", tx, start);
  return tx.hash;
}

export async function relayWithdraw(proof: string, inputs: unknown, recipientAddress: string): Promise<string> {
  const start = Date.now();
  const inp = inputs as Record<string, unknown>;
  logger.info({
    event: "relay:withdraw:start",
    proof_bytes: proofBytes(proof),
    proof_fingerprint: fingerprint(proof),
    nullifier_prefix: typeof inp["nullifier"] === "string" ? (inp["nullifier"] as string).slice(0, 10) : undefined,
    recipient_prefix: recipientAddress.slice(0, 10),
  }, "relay:withdraw:start");

  const tx = await sendWithNonce((nonce) =>
    (vault as ethers.Contract & {
      withdraw: (p: string, i: unknown, a: string, o: ethers.Overrides) => Promise<ethers.TransactionResponse>
    }).withdraw(proof, inputs, recipientAddress, { nonce }),
  );

  logger.info({ event: "relay:withdraw:tx_sent", txHash: tx.hash, nonce: tx.nonce, elapsed_ms: Date.now() - start }, "relay:withdraw:tx_sent");
  trackReceipt("relay:withdraw", tx, start);
  return tx.hash;
}

export async function relayBetCancellationCredit(proof: string, inputs: unknown): Promise<string> {
  const start = Date.now();
  const inp = inputs as Record<string, unknown>;
  logger.info({
    event: "relay:betCancellationCredit:start",
    proof_bytes: proofBytes(proof),
    proof_fingerprint: fingerprint(proof),
    nullifier_prefix: typeof inp["nullifier"] === "string" ? (inp["nullifier"] as string).slice(0, 10) : undefined,
  }, "relay:betCancellationCredit:start");

  const tx = await sendWithNonce((nonce) =>
    (vault as ethers.Contract & {
      betCancellationCredit: (p: string, i: unknown, o: ethers.Overrides) => Promise<ethers.TransactionResponse>
    }).betCancellationCredit(proof, inputs, { nonce }),
  );

  logger.info({ event: "relay:betCancellationCredit:tx_sent", txHash: tx.hash, nonce: tx.nonce, elapsed_ms: Date.now() - start }, "relay:betCancellationCredit:tx_sent");
  trackReceipt("relay:betCancellationCredit", tx, start);
  return tx.hash;
}

export async function relayNACancellationCredit(proof: string, inputs: unknown): Promise<string> {
  const start = Date.now();
  const inp = inputs as Record<string, unknown>;
  logger.info({
    event: "relay:naCancellationCredit:start",
    proof_bytes: proofBytes(proof),
    proof_fingerprint: fingerprint(proof),
    nullifier_prefix: typeof inp["nullifier"] === "string" ? (inp["nullifier"] as string).slice(0, 10) : undefined,
  }, "relay:naCancellationCredit:start");

  const tx = await sendWithNonce((nonce) =>
    (vault as ethers.Contract & {
      naCancellationCredit: (p: string, i: unknown, o: ethers.Overrides) => Promise<ethers.TransactionResponse>
    }).naCancellationCredit(proof, inputs, { nonce }),
  );

  logger.info({ event: "relay:naCancellationCredit:tx_sent", txHash: tx.hash, nonce: tx.nonce, elapsed_ms: Date.now() - start }, "relay:naCancellationCredit:tx_sent");
  trackReceipt("relay:naCancellationCredit", tx, start);
  return tx.hash;
}

// FC-1: relay a position-close credit proof. sell_proceeds is Vault-injected from
// the operator's reportSold, so the relay only forwards proof + the 4 public inputs.
export async function relayClosePosition(proof: string, inputs: unknown): Promise<string> {
  const start = Date.now();
  const inp = inputs as Record<string, unknown>;
  logger.info({
    event: "relay:closePosition:start",
    proof_bytes: proofBytes(proof),
    proof_fingerprint: fingerprint(proof),
    nullifier_prefix: typeof inp["nullifier"] === "string" ? (inp["nullifier"] as string).slice(0, 10) : undefined,
  }, "relay:closePosition:start");

  const tx = await sendWithNonce((nonce) =>
    (vault as ethers.Contract & {
      closePosition: (p: string, i: unknown, o: ethers.Overrides) => Promise<ethers.TransactionResponse>
    }).closePosition(proof, inputs, { nonce }),
  );

  logger.info({ event: "relay:closePosition:tx_sent", txHash: tx.hash, nonce: tx.nonce, elapsed_ms: Date.now() - start }, "relay:closePosition:tx_sent");
  trackReceipt("relay:closePosition", tx, start);
  return tx.hash;
}

// FC-4: relay a partial-fill credit proof. refund_amount (bet_amount - spent_amount)
// is Vault-injected from the operator's reportPartialFill, so the relay only forwards
// the proof + the 4 public inputs (same shape as betCancellationCredit).
export async function relayPartialFillCredit(proof: string, inputs: unknown): Promise<string> {
  const start = Date.now();
  const inp = inputs as Record<string, unknown>;
  logger.info({
    event: "relay:partialFillCredit:start",
    proof_bytes: proofBytes(proof),
    proof_fingerprint: fingerprint(proof),
    nullifier_prefix: typeof inp["nullifier"] === "string" ? (inp["nullifier"] as string).slice(0, 10) : undefined,
  }, "relay:partialFillCredit:start");

  const tx = await sendWithNonce((nonce) =>
    (vault as ethers.Contract & {
      partialFillCredit: (p: string, i: unknown, o: ethers.Overrides) => Promise<ethers.TransactionResponse>
    }).partialFillCredit(proof, inputs, { nonce }),
  );

  logger.info({ event: "relay:partialFillCredit:tx_sent", txHash: tx.hash, nonce: tx.nonce, elapsed_ms: Date.now() - start }, "relay:partialFillCredit:tx_sent");
  trackReceipt("relay:partialFillCredit", tx, start);
  return tx.hash;
}
