import { ethers } from "ethers";
import pino from "pino";

const logger = pino({ name: "relayer" });

// Vault ABI — only the functions the relay submits
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
}

export async function relayAuthorizeBet(proof: string, inputs: unknown): Promise<string> {
  logger.info("Relaying authorizeBet");
  const tx = await (vault as ethers.Contract & { authorizeBet: (proof: string, inputs: unknown) => Promise<ethers.TransactionResponse> }).authorizeBet(proof, inputs);
  return tx.hash;
}

export async function relayCreditSettlement(proof: string, inputs: unknown): Promise<string> {
  logger.info("Relaying creditSettlement");
  const tx = await (vault as ethers.Contract & { creditSettlement: (proof: string, inputs: unknown) => Promise<ethers.TransactionResponse> }).creditSettlement(proof, inputs);
  return tx.hash;
}

export async function relayWithdraw(proof: string, inputs: unknown, recipientAddress: string): Promise<string> {
  logger.info({ recipientAddress }, "Relaying withdraw");
  const tx = await (vault as ethers.Contract & { withdraw: (proof: string, inputs: unknown, addr: string) => Promise<ethers.TransactionResponse> }).withdraw(proof, inputs, recipientAddress);
  return tx.hash;
}

export async function relayBetCancellationCredit(proof: string, inputs: unknown): Promise<string> {
  logger.info("Relaying betCancellationCredit");
  const tx = await (vault as ethers.Contract & { betCancellationCredit: (proof: string, inputs: unknown) => Promise<ethers.TransactionResponse> }).betCancellationCredit(proof, inputs);
  return tx.hash;
}

export async function relayNACancellationCredit(proof: string, inputs: unknown): Promise<string> {
  logger.info("Relaying naCancellationCredit");
  const tx = await (vault as ethers.Contract & { naCancellationCredit: (proof: string, inputs: unknown) => Promise<ethers.TransactionResponse> }).naCancellationCredit(proof, inputs);
  return tx.hash;
}
