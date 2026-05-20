import { ethers } from "ethers";
import pino from "pino";
import { submitFOKOrder } from "./orderBuilder.js";
import { config } from "./config.js";

const logger = pino({ name: "event-listener" });

const VAULT_ABI = [
  "event BetAuthorized(bytes32 indexed nullifier, bytes32 market_id, bytes32 position_id, uint64 expected_shares, uint256 bet_amount, uint64 price, bytes32 new_commitment)",
];

export function startEventListener(
  provider: ethers.JsonRpcProvider,
  wallet: ethers.Wallet
): void {
  const vault = new ethers.Contract(config.vaultContractAddress, VAULT_ABI, provider);

  vault.on(
    "BetAuthorized",
    async (
      nullifier: string,
      market_id: string,
      position_id: string,
      expected_shares: bigint,
      bet_amount: bigint,
      price: bigint,
      new_commitment: string,
      event: ethers.EventLog
    ) => {
      try {
        // Wait for at least 1 confirmation before submitting the CLOB order
        const receipt = await provider.waitForTransaction(event.transactionHash, 1);
        if (!receipt || receipt.status !== 1) {
          logger.warn({ nullifier, txHash: event.transactionHash }, "BetAuthorized tx failed — skipping");
          return;
        }

        logger.info({ nullifier, market_id, position_id, bet_amount: bet_amount.toString() }, "BetAuthorized confirmed");

        // The Signing Layer reads public event data only.
        // User note preimage (secret, balance, nonce) is never received here.
        await submitFOKOrder(
          { nullifier, market_id, position_id, expected_shares, bet_amount, price, new_commitment },
          wallet,
          provider
        );
      } catch (err) {
        logger.error({ err, nullifier }, "Failed to process BetAuthorized event");
      }
    }
  );

  logger.info({ vault: config.vaultContractAddress }, "Listening for BetAuthorized events");
}
