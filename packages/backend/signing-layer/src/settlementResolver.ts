import { ethers } from "ethers";
import pino from "pino";
import { config } from "./config";
import { runRedemptionPipeline, readNumerators } from "./redemptionPipeline";
import { cancelOrdersForMarket } from "./wsFillTracker";
import { signingLayerNonceManager } from "./nonceManager";
import { conditionIdForKey, marketMetaForKey, toFieldSafe } from "./marketRegistry";
import { getTrackedMarkets, upsertTrackedMarket, trackedMarketCount } from "./trackedMarkets";
import { fetchResolvedMarkets } from "./vaultEventSource";

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
const SETTLEMENT_POLL_MS = Number(process.env.SETTLEMENT_POLL_MS ?? "120000");

// Markets (reduced key) known resolved-on-chain — skip re-checking them. Populated by (a) this
// process's own resolutions, and (b) a periodic seed from the proof-relay's MarketResolved index.
const resolvedMarkets = new Set<string>();

// Seed the resolved-set from the proof-relay's MarketResolved index instead of probing
// Vault.marketResolvedAt per market. Refreshed periodically; while the seed is FRESH, the per-market
// marketResolvedAt eth_call is skipped entirely (a market absent from the index is genuinely
// unresolved on-chain). If the relay is unavailable, the seed goes stale and the poll falls back to
// the on-chain marketResolvedAt check — so resilience is preserved.
const RESOLVED_REFRESH_MS = Number(process.env.RESOLVED_REFRESH_MS ?? "300000"); // 5 min
const SEED_FRESH_MS = RESOLVED_REFRESH_MS * 3; // tolerate a couple of failed refreshes before falling back
let _resolvedSeededAt = 0;

async function refreshResolvedFromIndex(): Promise<void> {
  try {
    const ids = await fetchResolvedMarkets();
    if (ids === null) return; // relay down → keep the per-market marketResolvedAt fallback
    let added = 0;
    for (const id of ids) {
      const key = toFieldSafe(id);
      if (!resolvedMarkets.has(key)) added++;
      resolvedMarkets.add(key);
    }
    _resolvedSeededAt = Date.now();
    logger.info({ total: ids.length, newlyAdded: added }, "settlement: seeded resolved markets from proof-relay index");
  } catch (err) {
    logger.warn({ err: String(err) }, "settlement: resolved-markets seed failed (using per-market check)");
  }
}

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

// NOTE: the former live `ctf.on("ConditionResolution")` subscription (and its `isVaultMarket`
// global-event filter + `filtersSupported` RPC probe) were removed — over an HTTP RPC the subscription
// forced a background eth_blockNumber + getLogs poller every ~4s and only ever fired on filter-capable
// RPCs. Settlement now runs solely via the tracked-markets poll below, which is RPC-cheap and works on
// every provider (including pruned/filter-less public nodes).

export function startSettlementResolver(
  provider: ethers.JsonRpcProvider,
  wallet: ethers.Wallet
): void {
  // Single path: poll the locally-persisted tracked_markets table — the markets the Vault has bets
  // on, recorded at bet-submission time — and check each for CTF finalization via the payoutDenominator
  // STATE read (which even pruned nodes serve). No historical eth_getLogs.
  //
  // The former "Path 1" live `ctf.on("ConditionResolution")` subscription has been removed: over an
  // HTTP RPC it forced a background eth_blockNumber + getLogs poller every ~4s forever, and it only
  // ever fired on filter-capable RPCs (it was already skipped on Ankr/publicnode). The poll below is
  // sufficient on every RPC and does the same redemption work, so the subscription was pure duplicated
  // RPC load. `filtersSupported` is retained for diagnostics but no longer gates a subscription.
  seedTrackedMarkets();
  // Seed the resolved-set from the proof-relay's MarketResolved index (replaces the per-market
  // Vault.marketResolvedAt eth_call when fresh) + refresh it periodically.
  void refreshResolvedFromIndex();
  setInterval(() => void refreshResolvedFromIndex(), RESOLVED_REFRESH_MS);
  startSettlementPoll(provider, wallet);

  logger.info(
    { ctf: config.ctfAddress, vault: config.vaultContractAddress, pollMs: SETTLEMENT_POLL_MS, resolvedRefreshMs: RESOLVED_REFRESH_MS },
    "Settlement resolver started (poll-only; resolved-set seeded from proof-relay index)"
  );
}

// C2: per-market adaptive backoff. A market past its endDate but not yet finalized on CTF (resolution
// lag is routinely minutes→hours) doesn't need an eth_call every tick. After each "still unresolved"
// check we push the market's next check out exponentially (base → cap), so an idling market costs ~one
// probe per backoff window instead of one per poll. Cleared when the market resolves.
const SETTLE_BACKOFF_BASE_MS = Number(process.env.SETTLEMENT_BACKOFF_BASE_MS ?? "60000");      // 1 min
const SETTLE_BACKOFF_MAX_MS = Number(process.env.SETTLEMENT_BACKOFF_MAX_MS ?? "1800000");      // 30 min
const _settleBackoff = new Map<string, { misses: number; nextAt: number }>();

function backoffMarket(reducedKey: string, now: number): void {
  const misses = (_settleBackoff.get(reducedKey)?.misses ?? 0) + 1;
  const delay = Math.min(SETTLE_BACKOFF_MAX_MS, SETTLE_BACKOFF_BASE_MS * 2 ** (misses - 1));
  _settleBackoff.set(reducedKey, { misses, nextAt: now + delay });
}

function startSettlementPoll(provider: ethers.JsonRpcProvider, wallet: ethers.Wallet): void {
  const vault = new ethers.Contract(config.vaultContractAddress, VAULT_ABI, provider);
  const ctf = new ethers.Contract(config.ctfAddress, CTF_ABI, provider);

  const tick = async () => {
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const nowMs = Date.now();
      // When the resolved-set was recently seeded from the proof-relay index, a market absent from it
      // is genuinely unresolved on-chain — so skip the per-market Vault.marketResolvedAt eth_call. If
      // the seed is stale/unavailable (relay down), fall back to the on-chain check.
      const seedFresh = _resolvedSeededAt > 0 && nowMs - _resolvedSeededAt < SEED_FRESH_MS;
      // Source of markets = the locally-persisted tracked_markets table. NO historical eth_getLogs,
      // so this works on a pruned RPC (which refuses logs older than its prune window).
      for (const { reducedKey, rawConditionId, endDate } of getTrackedMarkets()) {
        if (resolvedMarkets.has(reducedKey)) continue;
        // Resolution-time gate FIRST (no RPC): a timed market can't resolve before its endDate, so a
        // pre-endDate market costs zero chain calls. Open-ended markets (no endDate) fall through.
        if (endDate && nowSec < endDate) continue;
        // Backoff gate: skip BOTH eth_calls until this market's next scheduled check.
        const bo = _settleBackoff.get(reducedKey);
        if (bo && nowMs < bo.nextAt) continue;
        try {
          // Per-market on-chain resolved check — only when the index seed isn't fresh (else the seed
          // already told us which markets are resolved, with no eth_call).
          if (!seedFresh) {
            const resolvedAt: bigint = await vault.marketResolvedAt(reducedKey);
            if (resolvedAt > 0n) {
              resolvedMarkets.add(reducedKey); // already resolved on-chain — nothing to do
              _settleBackoff.delete(reducedKey);
              continue;
            }
          }

          // Prefer the stored raw conditionId; if it's just the reduced key (resolveToken missed at bet
          // time), fall back to the registry. Without the real conditionId, CTF can't be queried.
          const raw = rawConditionId && rawConditionId !== reducedKey ? rawConditionId : (conditionIdForKey(reducedKey) ?? rawConditionId);
          if (!raw || raw === reducedKey) { backoffMarket(reducedKey, nowMs); continue; }

          const denominator: bigint = await ctf.payoutDenominator(raw);
          if (denominator === 0n) { backoffMarket(reducedKey, nowMs); continue; } // not finalized on CTF yet

          logger.info({ reducedKey, rawConditionId: raw }, "poll: market resolved on CTF — running settlement");
          await handleResolution(provider, wallet, raw, await provider.getBlockNumber());
          resolvedMarkets.add(reducedKey);
          _settleBackoff.delete(reducedKey);
        } catch (err) {
          logger.error({ err, reducedKey }, "poll: settlement check failed for market");
          backoffMarket(reducedKey, nowMs);
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
