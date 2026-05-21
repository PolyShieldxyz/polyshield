import { ethers } from "ethers";
import pino from "pino";

const logger = pino({ name: "relayer", level: "debug" });

const VAULT_ABI = [
  "function authorizeBet(bytes calldata proof, tuple(bytes32 merkle_root, bytes32 nullifier, bytes32 new_commitment, uint64 bet_amount, uint64 price, uint64 expected_shares, bytes32 market_id, uint8 outcome_side, bytes32 position_id) calldata inputs)",
  "function creditSettlement(bytes calldata proof, tuple(bytes32 merkle_root, bytes32 nullifier, bytes32 new_commitment, bytes32 nullifier_of_bet, bytes32 market_id, uint64 payout_per_share, uint64 total_credit) calldata inputs)",
  "function withdraw(bytes calldata proof, tuple(bytes32 merkle_root, bytes32 nullifier, uint64 withdrawal_amount, bytes32 recipient_hash) calldata inputs, address recipientAddress)",
  "function betCancellationCredit(bytes calldata proof, tuple(bytes32 merkle_root, bytes32 nullifier, bytes32 new_commitment, bytes32 nullifier_of_bet) calldata inputs)",
  "function naCancellationCredit(bytes calldata proof, tuple(bytes32 merkle_root, bytes32 nullifier, bytes32 new_commitment, bytes32 nullifier_of_bet, bytes32 market_id) calldata inputs)",
];

let wallet: ethers.Wallet;
let vault: ethers.Contract;

export function initRelayer(relayerKey: string, vaultAddress: string, provider: ethers.JsonRpcProvider): void {
  wallet = new ethers.Wallet(relayerKey, provider);
  vault = new ethers.Contract(vaultAddress, VAULT_ABI, wallet);
  logger.info({ relayerAddress: wallet.address, vaultAddress }, "relayer:init");
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
  logger.info({
    event: "relay:authorizeBet:start",
    proof_bytes: proofBytes(proof),
    proof_fingerprint: fingerprint(proof),
    inputs,
  }, "relay:authorizeBet:start");

  const tx = await (vault as ethers.Contract & {
    authorizeBet: (p: string, i: unknown) => Promise<ethers.TransactionResponse>
  }).authorizeBet(proof, inputs);

  logger.info({ event: "relay:authorizeBet:tx_sent", txHash: tx.hash, nonce: tx.nonce, elapsed_ms: Date.now() - start }, "relay:authorizeBet:tx_sent");
  trackReceipt("relay:authorizeBet", tx, start);
  return tx.hash;
}

export async function relayCreditSettlement(proof: string, inputs: unknown): Promise<string> {
  const start = Date.now();
  logger.info({
    event: "relay:creditSettlement:start",
    proof_bytes: proofBytes(proof),
    proof_fingerprint: fingerprint(proof),
    inputs,
  }, "relay:creditSettlement:start");

  const tx = await (vault as ethers.Contract & {
    creditSettlement: (p: string, i: unknown) => Promise<ethers.TransactionResponse>
  }).creditSettlement(proof, inputs);

  logger.info({ event: "relay:creditSettlement:tx_sent", txHash: tx.hash, nonce: tx.nonce, elapsed_ms: Date.now() - start }, "relay:creditSettlement:tx_sent");
  trackReceipt("relay:creditSettlement", tx, start);
  return tx.hash;
}

export async function relayWithdraw(proof: string, inputs: unknown, recipientAddress: string): Promise<string> {
  const start = Date.now();
  logger.info({
    event: "relay:withdraw:start",
    proof_bytes: proofBytes(proof),
    proof_fingerprint: fingerprint(proof),
    recipientAddress,
    inputs,
  }, "relay:withdraw:start");

  const tx = await (vault as ethers.Contract & {
    withdraw: (p: string, i: unknown, a: string) => Promise<ethers.TransactionResponse>
  }).withdraw(proof, inputs, recipientAddress);

  logger.info({ event: "relay:withdraw:tx_sent", txHash: tx.hash, nonce: tx.nonce, elapsed_ms: Date.now() - start }, "relay:withdraw:tx_sent");
  trackReceipt("relay:withdraw", tx, start);
  return tx.hash;
}

export async function relayBetCancellationCredit(proof: string, inputs: unknown): Promise<string> {
  const start = Date.now();
  logger.info({
    event: "relay:betCancellationCredit:start",
    proof_bytes: proofBytes(proof),
    proof_fingerprint: fingerprint(proof),
    inputs,
  }, "relay:betCancellationCredit:start");

  const tx = await (vault as ethers.Contract & {
    betCancellationCredit: (p: string, i: unknown) => Promise<ethers.TransactionResponse>
  }).betCancellationCredit(proof, inputs);

  logger.info({ event: "relay:betCancellationCredit:tx_sent", txHash: tx.hash, nonce: tx.nonce, elapsed_ms: Date.now() - start }, "relay:betCancellationCredit:tx_sent");
  trackReceipt("relay:betCancellationCredit", tx, start);
  return tx.hash;
}

export async function relayNACancellationCredit(proof: string, inputs: unknown): Promise<string> {
  const start = Date.now();
  logger.info({
    event: "relay:naCancellationCredit:start",
    proof_bytes: proofBytes(proof),
    proof_fingerprint: fingerprint(proof),
    inputs,
  }, "relay:naCancellationCredit:start");

  const tx = await (vault as ethers.Contract & {
    naCancellationCredit: (p: string, i: unknown) => Promise<ethers.TransactionResponse>
  }).naCancellationCredit(proof, inputs);

  logger.info({ event: "relay:naCancellationCredit:tx_sent", txHash: tx.hash, nonce: tx.nonce, elapsed_ms: Date.now() - start }, "relay:naCancellationCredit:tx_sent");
  trackReceipt("relay:naCancellationCredit", tx, start);
  return tx.hash;
}
