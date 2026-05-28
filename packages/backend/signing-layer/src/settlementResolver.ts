import { ethers } from "ethers";
import pino from "pino";
import { config } from "./config";
import { runRedemptionPipeline } from "./redemptionPipeline";

const logger = pino({ name: "settlement-resolver" });

const CTF_ABI = [
  "event ConditionResolution(bytes32 indexed conditionId, address indexed oracle, bytes32 indexed questionId, uint256 outcomeSlotCount, uint256[] payoutNumerators)",
  "function payoutNumerators(bytes32 conditionId) view returns (uint256[])",
  "function payoutDenominator(bytes32 conditionId) view returns (uint256)",
];

const VAULT_ABI = [
  "function resolveMarket(bytes32 market_id) external",
  "function pendingCredit(bytes32 market_id) view returns (uint64)",
];

export function startSettlementResolver(
  provider: ethers.JsonRpcProvider,
  wallet: ethers.Wallet
): void {
  const ctf = new ethers.Contract(config.ctfAddress, CTF_ABI, provider);

  ctf.on(
    "ConditionResolution",
    async (
      conditionId: string,
      _oracle: string,
      _questionId: string,
      _outcomeSlotCount: bigint,
      payoutNumerators: bigint[],
      event: ethers.ContractEventPayload
    ) => {
      try {
        await provider.waitForTransaction(event.log.transactionHash, 1);

        const allZero = payoutNumerators.every((n) => n === 0n);
        if (allZero) {
          logger.info({ conditionId }, "N/A market resolved — skipping pipeline");
          return;
        }

        await runRedemptionPipeline(provider, wallet, conditionId, event.log.blockNumber);
      } catch (err) {
        logger.error({ err, conditionId }, "Failed to run redemption pipeline");
      }
    }
  );

  logger.info({ ctf: config.ctfAddress, vault: config.vaultContractAddress }, "Settlement resolver started");
}

/**
 * Manually resolve a market — runs full pipeline if not yet resolved.
 */
export async function resolveMarketManually(
  provider: ethers.JsonRpcProvider,
  wallet: ethers.Wallet,
  market_id: string
): Promise<void> {
  const vault = new ethers.Contract(config.vaultContractAddress, VAULT_ABI, wallet);
  const existing: bigint = await vault.pendingCredit(market_id);
  if (existing > 0n) {
    logger.info({ market_id }, "Market already resolved in Vault");
    return;
  }

  const block = await provider.getBlockNumber();
  await runRedemptionPipeline(provider, wallet, market_id, block);
}
