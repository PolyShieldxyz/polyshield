import { ethers } from "ethers";
import pino from "pino";
import { upsertSettlement } from "./database.js";

const logger = pino({ name: "ctf-listener" });

// Production: Gnosis CTF on Polygon. Override with CTF_ADDRESS env var for local dev (MockCTF).
const CTF_ADDRESS = process.env.CTF_ADDRESS ?? "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";

const CTF_ABI = [
  "event ConditionResolution(bytes32 indexed conditionId, address indexed oracle, bytes32 indexed questionId, uint256 outcomeSlotCount, uint256[] payoutNumerators)",
  "function payoutNumerators(bytes32 conditionId) view returns (uint256[])",
  "function payoutDenominator(bytes32 conditionId) view returns (uint256)",
];

export async function startCTFListener(provider: ethers.JsonRpcProvider): Promise<void> {
  const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);

  ctf.on(
    "ConditionResolution",
    async (
      conditionId: string,
      _oracle: string,
      _questionId: string,
      _outcomeSlotCount: bigint,
      payoutNumerators: bigint[],
      event: ethers.EventLog
    ) => {
      try {
        const blockNumber = event.blockNumber;
        const denominator: bigint = await ctf.payoutDenominator(conditionId);

        // Determine outcome: if all numerators are 0 it's N/A
        const allZero = payoutNumerators.every((n) => n === 0n);
        let outcome: number;
        let payoutPerShare = 0;

        if (allZero) {
          outcome = -1; // N/A
        } else {
          // YES is index 1 in Polymarket binary markets
          const yesNumerator = payoutNumerators[1] ?? 0n;
          if (yesNumerator > 0n) {
            outcome = 1; // YES wins
            payoutPerShare = Number((yesNumerator * 1_000_000n) / denominator);
          } else {
            outcome = 0; // NO wins
            const noNumerator = payoutNumerators[0] ?? 0n;
            payoutPerShare = Number((noNumerator * 1_000_000n) / denominator);
          }
        }

        upsertSettlement({
          market_id: conditionId,
          condition_id: conditionId,
          position_id: "", // populated by signing layer on redemption
          payout_per_share: payoutPerShare,
          block_number: blockNumber,
          outcome,
          created_at: Math.floor(Date.now() / 1000),
        });

        logger.info({ conditionId, outcome, payoutPerShare, blockNumber }, "Settlement recorded");
      } catch (err) {
        logger.error({ err, conditionId }, "Failed to process ConditionResolution");
      }
    }
  );

  logger.info({ address: CTF_ADDRESS }, "Listening for CTF settlements");
}
