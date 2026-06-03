import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import pino from "pino";
import { submitFOKOrder, submitLimitOrder, submitFAKOrder } from "./orderBuilder";
import { getLimitOrder } from "./limitOrderStore";
import { getAttestation } from "./attestationStore";
import { config } from "./config";

const STATE_FILE = path.join(process.cwd(), "data", "event-listener-state.json");
const SAFETY_BUFFER = 100;

function loadLastBlock(): number {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as { lastBlock?: unknown };
    return typeof data.lastBlock === "number" ? data.lastBlock : 0;
  } catch {
    return 0;
  }
}

function saveLastBlock(blockNumber: number): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastBlock: blockNumber }));
}

const logger = pino({ name: "event-listener" });

const VAULT_ABI = [
  // M2: outcome_side now included — avoids per-bet betRecords() RPC during settlement.
  "event BetAuthorized(bytes32 indexed nullifier, bytes32 market_id, bytes32 position_id, uint64 expected_shares, uint256 bet_amount, uint64 price, uint8 outcome_side, bytes32 new_commitment)",
  "function betRecords(bytes32 nullifier) view returns (bytes32 market_id, bytes32 condition_id, bytes32 position_id, uint64 expected_shares, uint64 bet_amount, uint8 outcome_side, uint8 status)",
];

async function processBetEvent(
  nullifier: string,
  market_id: string,
  position_id: string,
  expected_shares: bigint,
  bet_amount: bigint,
  price: bigint,
  new_commitment: string,
  wallet: ethers.Wallet,
  provider: ethers.JsonRpcProvider
): Promise<void> {
  const orderEvent = { nullifier, market_id, position_id, expected_shares, bet_amount, price, new_commitment };

  // FC-4: if the frontend registered an order-type intent for this nullifier, route
  // accordingly: FAK (fill-and-kill market order) or a resting GTC/GTD limit order.
  // Otherwise default to FOK (unchanged behavior).
  const intent = getLimitOrder(nullifier);
  if (intent) {
    logger.info({ nullifier, order_type: intent.order_type }, "order-type intent found — routing");
    if (intent.order_type === "FAK") {
      await submitFAKOrder(orderEvent, wallet, provider);
    } else {
      await submitLimitOrder(orderEvent, { orderType: intent.order_type, expiration: intent.expiration }, wallet, provider);
    }
    return;
  }

  await submitFOKOrder(orderEvent, wallet, provider);
}

/**
 * On startup, scan all historical BetAuthorized events and re-submit any that
 * still have ACTIVE status (i.e. the signing layer missed them on a previous run).
 * This handles chain restarts and signing layer restarts without data loss.
 */
async function catchUpMissedBets(
  vault: ethers.Contract,
  wallet: ethers.Wallet,
  provider: ethers.JsonRpcProvider
): Promise<void> {
  logger.info("event-listener: scanning for missed BetAuthorized events...");
  try {
    // API-009: clamp the persisted cursor to [0, currentBlock]. A corrupt or
    // oversized lastBlock (e.g. from a tampered/garbled state file, or after a
    // chain reset to a lower height) would otherwise push fromBlock past the
    // chain head and silently skip the entire history scan.
    const currentBlock = await provider.getBlockNumber();
    const rawLastBlock = loadLastBlock();
    const lastBlock = Math.min(Math.max(0, Number(rawLastBlock) || 0), currentBlock);
    const fromBlock = Math.max(0, lastBlock - SAFETY_BUFFER);
    logger.info({ fromBlock, lastBlock, currentBlock, rawLastBlock }, "event-listener: catchup scan range");

    const filter = vault.filters.BetAuthorized();
    const logs = await vault.queryFilter(filter, fromBlock, "latest");
    logger.info({ count: logs.length }, "event-listener: historical BetAuthorized events found");

    let maxBlock = lastBlock;
    for (const log of logs) {
      if (log.blockNumber > maxBlock) maxBlock = log.blockNumber;

      const parsed = vault.interface.parseLog({ topics: log.topics as string[], data: log.data });
      if (!parsed) continue;

      const nullifier = parsed.args[0] as string;
      try {
        // FC-9: on-chain status is no longer advanced by report* (those are gone),
        // so an ACTIVE on-chain status no longer means "not yet handled" — the order
        // may already be filled. Dedupe on the off-chain attestation store instead:
        // a persisted attestation means the order already reached a terminal state,
        // so re-submitting would double-place on the CLOB.
        if (getAttestation(nullifier)) continue;

        // Skip bets that don't exist on-chain (e.g. reverted tx). The bet record's
        // market_id is bytes32(0) when no record was written.
        const rec = await vault.betRecords(nullifier);
        const market_id = rec[0] as string;
        if (!market_id || market_id === ethers.ZeroHash) continue;

        logger.warn({ nullifier }, "event-listener: found un-attested bet from missed event — reprocessing");
        await processBetEvent(
          nullifier,
          parsed.args[1] as string,   // market_id
          parsed.args[2] as string,   // position_id
          parsed.args[3] as bigint,   // expected_shares
          parsed.args[4] as bigint,   // bet_amount
          parsed.args[5] as bigint,   // price
          parsed.args[7] as string,   // new_commitment (index 7 after outcome_side at index 6)
          wallet,
          provider
        );
      } catch (err) {
        logger.error({ err, nullifier }, "event-listener: catchup failed for bet");
      }
    }

    if (maxBlock > lastBlock) saveLastBlock(maxBlock);
  } catch (err) {
    logger.error({ err }, "event-listener: catchup scan failed");
  }
}

export function startEventListener(
  provider: ethers.JsonRpcProvider,
  wallet: ethers.Wallet
): void {
  const vault = new ethers.Contract(config.vaultContractAddress, VAULT_ABI, provider);

  // Catch up any ACTIVE bets that were placed before this process started
  void catchUpMissedBets(vault, wallet, provider);

  vault.on(
    "BetAuthorized",
    async (
      nullifier: string,
      market_id: string,
      position_id: string,
      expected_shares: bigint,
      bet_amount: bigint,
      price: bigint,
      outcome_side: number,
      new_commitment: string,
      event: ethers.ContractEventPayload
    ) => {
      try {
        // Wait for at least 1 confirmation before submitting the CLOB order
        const receipt = await provider.waitForTransaction(event.log.transactionHash, 1);
        if (!receipt || receipt.status !== 1) {
          logger.warn({ nullifier, txHash: event.log.transactionHash }, "BetAuthorized tx failed — skipping");
          return;
        }

        logger.info({ nullifier, market_id, position_id, bet_amount: bet_amount.toString() }, "BetAuthorized confirmed");

        // The Signing Layer reads public event data only.
        // User note preimage (secret, balance, nonce) is never received here.
        await processBetEvent(nullifier, market_id, position_id, expected_shares, bet_amount, price, new_commitment, wallet, provider);
        saveLastBlock(event.log.blockNumber);
      } catch (err) {
        logger.error({ err, nullifier }, "Failed to process BetAuthorized event");
      }
    }
  );

  logger.info({ vault: config.vaultContractAddress }, "Listening for BetAuthorized events");
}
