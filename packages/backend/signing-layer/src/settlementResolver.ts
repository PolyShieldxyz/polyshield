import { ethers } from "ethers";
import pino from "pino";
import { config } from "./config";
import { runRedemptionPipeline, readNumerators } from "./redemptionPipeline";
import { cancelOrdersForMarket } from "./wsFillTracker";
import { signingLayerNonceManager } from "./nonceManager";
import { conditionIdForKey, marketMetaForKey, toFieldSafe } from "./marketRegistry";
import { getTrackedMarkets, upsertTrackedMarket, trackedMarketCount } from "./trackedMarkets";

const logger = pino({ name: "settlement-resolver" });

const CTF_ABI = [
  "event ConditionResolution(bytes32 indexed conditionId, address indexed oracle, bytes32 indexed questionId, uint256 outcomeSlotCount, uint256[] payoutNumerators)",
  // Real CTF exposes the element accessor only (see readNumerators / ICTF) — NOT a (bytes32)->uint256[] getter.
  "function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)",
  "function getOutcomeSlotCount(bytes32 conditionId) view returns (uint256)",
  "function payoutDenominator(bytes32 conditionId) view returns (uint256)",
];

const VAULT_ABI = [
  "function resolveMarket(bytes32 market_id) external",
  "function registerCondition(bytes32 condition_id) external",
  "function pendingCredit(bytes32 market_id, uint8 outcome_side) view returns (uint64)",
  "function marketResolvedAt(bytes32 circuit_key) view returns (uint64)",
  // Must match the deployed Vault exactly (FC-14 appended protocolFee, relayFee) so the signature
  // hash / decoding line up with the on-chain event.
  "event BetAuthorized(bytes32 indexed nullifier, bytes32 market_id, bytes32 position_id, uint64 expected_shares, uint256 bet_amount, uint64 price, uint8 outcome_side, bytes32 new_commitment, uint64 protocolFee, uint64 relayFee)",
];

// Poll cadence for the settlement scan. Resolution is a slow, infrequent event, so this can be
// looser than the bet-auth poller. publicnode has no eth_newFilter/getFilterChanges support, so a
// live `ctf.on` subscription silently dies there (see eventListener.ts) — hence this poll fallback.
const SETTLEMENT_POLL_MS = Number(process.env.SETTLEMENT_POLL_MS ?? "30000");

// Markets (reduced key) already driven to resolution this process — skip re-checking them.
const resolvedMarkets = new Set<string>();

// Backfill for bets placed BEFORE the tracked_markets table existed (their BetAuthorized logs are
// now pruned and unreadable). Each is a reduced on-chain market_id; the raw conditionId + endDate are
// recovered from the market registry at startup. New bets self-register via eventListener.processBetEvent,
// so this list is a one-time bridge, not a growing hardcode. Overridable via SEED_TRACKED_MARKETS
// (comma-separated reduced keys) if a future deploy needs different seeds.
const SEED_REDUCED_KEYS = (process.env.SEED_TRACKED_MARKETS ??
  [
    "0x2d6e8f65d27ad8a2fe800fb8ea1a9325967a2596ff35252b44c4a8e0aa285da3",
    "0x0d5e78d047074b8e0c8089ced66e16344eec5539c99909ea92a64071d3783760",
    "0x0225da0145cfaa37a1c164e4f6e0c16e4d1b5960df514bc9835803e7cc18056c",
    "0x16d947950f364ffa00892d31bfc8b82732f607b42cb84205f7e181c68f8c541f",
    "0x20419d45cc690649ad357f18d6e47f4b8a63223183d00c045685632ea77debbf",
    "0x289df164012d73927714751dd2bb6e932fa30c9e56ae0940119862be75d5cb4f",
  ].join(",")
).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

/** Ensure the pre-existing markets are in tracked_markets, recovering raw conditionId + endDate from
 * the registry. Idempotent (upsert). Logs how many seeds could not be resolved (registry not synced). */
function seedTrackedMarkets(): void {
  let resolved = 0;
  let missing = 0;
  for (const reducedKey of SEED_REDUCED_KEYS) {
    const meta = marketMetaForKey(reducedKey);
    if (!meta) { missing++; continue; }
    upsertTrackedMarket(reducedKey, meta.conditionId, meta.endDate);
    resolved++;
  }
  logger.info({ resolved, missing, total: trackedMarketCount() }, "tracked_markets seeded");
}

/**
 * Drive a single resolved market through to the Vault. Shared by the live `ctf.on` handler and the
 * poll fallback. Idempotent: runRedemptionPipeline guards on marketResolvedAt and resolveMarket
 * reverts MarketAlreadyResolved, so a duplicate call from both paths is harmless.
 *
 * @param conditionId the REAL CTF conditionId (NOT the reduced on-chain market_id).
 */
async function handleResolution(
  provider: ethers.JsonRpcProvider,
  wallet: ethers.Wallet,
  conditionId: string,
  blockNumber: number,
): Promise<void> {
  // A resolved market can no longer fill resting orders, so cancel any still on the book
  // (→ FAILED attestation) so depositors can reclaim. Handles GTC (never expires) and a GTD
  // still resting at resolution.
  cancelOrdersForMarket(conditionId);

  const ctf = new ethers.Contract(config.ctfAddress, CTF_ABI, provider);
  const numerators: bigint[] = await readNumerators(ctf, conditionId);

  if (numerators.length > 0 && numerators.every((n) => n === 0n)) {
    // FC-11: N/A market — resolveMarket reverts NotNA for all-zero payouts, so register the real
    // conditionId on-chain instead. Without this the Vault has only the lossy field-safe market_id
    // and naCancellationCredit (the user's refund path for N/A) cannot query CTF.
    logger.info({ conditionId }, "N/A market resolved — registering condition for cancellation");
    try {
      const vault = new ethers.Contract(config.vaultContractAddress, VAULT_ABI, wallet);
      const tx = await signingLayerNonceManager.send(provider, wallet, (nonce) =>
        vault.registerCondition(conditionId, { nonce }),
      );
      await tx.wait(1);
      logger.info({ conditionId }, "registered N/A condition on Vault");
    } catch (err) {
      logger.error({ err, conditionId }, "registerCondition failed (N/A refunds blocked until retried)");
    }
    return;
  }

  await runRedemptionPipeline(provider, wallet, conditionId, blockNumber);
}

// CTF.ConditionResolution is a GLOBAL event — every market resolving on all of Polymarket fires it.
// On a real RPC (Alchemy) the subscription is live, so without this filter the resolver would try to
// redeem/resolve HUNDREDS of unrelated markets at once → RPC 429 storm → crash. Only act on markets
// the vault actually has bets on (tracked_markets). Cached briefly to avoid a DB hit per global event.
let _trackedCache: { keys: Set<string>; at: number } | null = null;
function isVaultMarket(conditionId: string): boolean {
  const now = Date.now();
  if (!_trackedCache || now - _trackedCache.at > 10_000) {
    _trackedCache = { keys: new Set(getTrackedMarkets().map((m) => m.reducedKey.toLowerCase())), at: now };
  }
  return _trackedCache.keys.has(toFieldSafe(conditionId).toLowerCase());
}

/**
 * Probe whether the RPC supports filter methods (eth_newFilter). Public providers like Ankr/
 * publicnode return "Method disabled" — attaching a `.on` subscription there does nothing but
 * spam an eth_newFilter error every few seconds forever. Anvil/dev and full archive nodes support
 * it. We probe once at startup and only attach the live subscription when it actually works.
 */
async function filtersSupported(provider: ethers.JsonRpcProvider): Promise<boolean> {
  try {
    const id = (await provider.send("eth_newFilter", [{ fromBlock: "latest", toBlock: "latest" }])) as string;
    try { await provider.send("eth_uninstallFilter", [id]); } catch { /* best-effort cleanup */ }
    return true;
  } catch {
    return false;
  }
}

export function startSettlementResolver(
  provider: ethers.JsonRpcProvider,
  wallet: ethers.Wallet
): void {
  const ctf = new ethers.Contract(config.ctfAddress, CTF_ABI, provider);

  // Path 1 — live subscription. Works against Anvil/dev (filters supported) and provides the raw
  // conditionId directly from the event. On a filter-disabled RPC (Ankr "Method disabled") this
  // subscription never fires AND retries eth_newFilter forever, so we attach it ONLY when a startup
  // probe confirms filter support; otherwise Path 2's poll is the sole (and sufficient) path.
  void (async () => {
    if (!(await filtersSupported(provider))) {
      logger.warn(
        "RPC does not support eth_newFilter — skipping live CTF subscription; settlement runs via poll fallback only",
      );
      return;
    }
    ctf.on(
      "ConditionResolution",
      async (
        conditionId: string,
        _oracle: string,
        _questionId: string,
        _outcomeSlotCount: bigint,
        _payoutNumerators: bigint[],
        event: ethers.ContractEventPayload
      ) => {
        try {
          if (!isVaultMarket(conditionId)) return; // global CTF event for a market the vault has no bets on
          await provider.waitForTransaction(event.log.transactionHash, 1);
          await handleResolution(provider, wallet, conditionId, event.log.blockNumber);
          resolvedMarkets.add(toFieldSafe(conditionId));
        } catch (err) {
          logger.error({ err, conditionId }, "Failed to run redemption pipeline (event path)");
        }
      }
    );
    logger.info("RPC supports filters — live CTF subscription attached");
  })();

  // Path 2 — poll fallback for public RPCs where `ctf.on` never fires (and pruned RPCs that can't
  // serve historical logs). We iterate the locally-persisted tracked_markets table — the markets the
  // Vault has bets on, recorded at bet-submission time — and check each for CTF finalization via the
  // payoutDenominator STATE read (which pruned nodes serve). No historical eth_getLogs.
  seedTrackedMarkets();
  startSettlementPoll(provider, wallet);

  logger.info(
    { ctf: config.ctfAddress, vault: config.vaultContractAddress, pollMs: SETTLEMENT_POLL_MS },
    "Settlement resolver started (live subscription + poll fallback)"
  );
}

function startSettlementPoll(provider: ethers.JsonRpcProvider, wallet: ethers.Wallet): void {
  const vault = new ethers.Contract(config.vaultContractAddress, VAULT_ABI, provider);
  const ctf = new ethers.Contract(config.ctfAddress, CTF_ABI, provider);

  const tick = async () => {
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      // Source of markets = the locally-persisted tracked_markets table. NO historical eth_getLogs,
      // so this works on a pruned RPC (which refuses logs older than its prune window).
      for (const { reducedKey, rawConditionId, endDate } of getTrackedMarkets()) {
        if (resolvedMarkets.has(reducedKey)) continue;
        try {
          const resolvedAt: bigint = await vault.marketResolvedAt(reducedKey);
          if (resolvedAt > 0n) {
            resolvedMarkets.add(reducedKey); // already resolved on-chain — nothing to do
            continue;
          }
          // Resolution-time gate: a timed market (crypto/sports) can't resolve before its endDate, so
          // don't bother CTF until then. Open-ended markets (endDate null/unknown) are checked every tick.
          if (endDate && nowSec < endDate) continue;

          // Prefer the stored raw conditionId; if it's just the reduced key (resolveToken missed at bet
          // time), fall back to the registry. Without the real conditionId, CTF can't be queried.
          const raw = rawConditionId && rawConditionId !== reducedKey ? rawConditionId : (conditionIdForKey(reducedKey) ?? rawConditionId);
          if (!raw || raw === reducedKey) continue;

          const denominator: bigint = await ctf.payoutDenominator(raw);
          if (denominator === 0n) continue; // not finalized on CTF yet

          logger.info({ reducedKey, rawConditionId: raw }, "poll: market resolved on CTF — running settlement");
          await handleResolution(provider, wallet, raw, await provider.getBlockNumber());
          resolvedMarkets.add(reducedKey);
        } catch (err) {
          logger.error({ err, reducedKey }, "poll: settlement check failed for market");
        }
      }
    } catch (err) {
      logger.error({ err }, "settlement poll tick failed");
    }
  };

  void tick();
  setInterval(() => void tick(), SETTLEMENT_POLL_MS);
}

/**
 * Manually resolve a market — runs the full pipeline if not yet resolved. Accepts either the raw
 * conditionId or the reduced on-chain market_id; recovers the raw conditionId via the registry
 * when needed (the pipeline and CTF require the raw value).
 */
export async function resolveMarketManually(
  provider: ethers.JsonRpcProvider,
  wallet: ethers.Wallet,
  market_id: string
): Promise<void> {
  const vault = new ethers.Contract(config.vaultContractAddress, VAULT_ABI, provider);

  // marketResolvedAt is keyed by the reduced circuit_key; pendingCredit needs (key, outcome_side),
  // so it cannot be queried with a single arg. Use marketResolvedAt for the idempotency check.
  const reducedKey = toFieldSafe(market_id);
  const resolvedAt: bigint = await vault.marketResolvedAt(reducedKey);
  if (resolvedAt > 0n) {
    logger.info({ market_id, reducedKey }, "Market already resolved in Vault");
    return;
  }

  // The pipeline/CTF need the raw conditionId. Prefer the registry (works when the caller passed
  // the reduced key); fall back to the supplied value (when the caller already passed the raw id).
  const rawConditionId = conditionIdForKey(reducedKey) ?? market_id;
  const block = await provider.getBlockNumber();
  await handleResolution(provider, wallet, rawConditionId, block);
}
