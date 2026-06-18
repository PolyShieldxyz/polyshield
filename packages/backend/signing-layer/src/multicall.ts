/**
 * Multicall3 batching for read-only view calls — collapses N `eth_call`s into ONE.
 *
 * Multicall3 is deployed at the same canonical address on every major chain (incl. Polygon):
 *   0xcA11bde05977b3631167028862bE2a173976CA11
 * `aggregate3` runs all sub-calls in a single eth_call and returns per-call (success, returnData).
 *
 * Falls back to individual eth_calls when Multicall3 isn't present (e.g. a local anvil) — probed once
 * and cached, so we don't pay a failed batch every time. Used by the settlement poll (payoutDenominator
 * across all markets in their resolution window) and the redemption pipeline (payoutNumerators /
 * balanceOf across slots/positions).
 */
import { ethers } from "ethers";

const MULTICALL3 = process.env.MULTICALL3_ADDRESS ?? "0xcA11bde05977b3631167028862bE2a173976CA11";
const MC3_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)",
];

interface Call3 {
  target: string;
  callData: string;
}

// Whether Multicall3 is callable here. Cached after the first probe, but only until `_disabledUntil`
// so a transient failure self-heals (re-probes) instead of disabling batching until process restart.
let _disabledUntil = 0;
const REPROBE_MS = Number(process.env.MULTICALL_REPROBE_MS ?? "600000"); // 10 min

/** Run a batch of calls in one eth_call. Returns returnData per call (null on per-call failure), or
 *  null overall when Multicall3 isn't available (caller falls back to individual calls). */
async function tryMulticall(provider: ethers.JsonRpcProvider, calls: Call3[]): Promise<(string | null)[] | null> {
  if (calls.length === 0) return [];
  if (Date.now() < _disabledUntil) return null; // recently found unavailable → skip the probe
  try {
    const mc = new ethers.Contract(MULTICALL3, MC3_ABI, provider);
    const results = (await mc.aggregate3(calls.map((c) => ({ target: c.target, allowFailure: true, callData: c.callData })))) as Array<{
      success: boolean;
      returnData: string;
    }>;
    _disabledUntil = 0;
    return results.map((r) => (r.success ? r.returnData : null));
  } catch {
    // No Multicall3 here (e.g. local anvil) or a transient error → fall back to individual calls, and
    // don't re-probe for a cooldown (so dev doesn't pay a failed batch every time; prod self-heals).
    _disabledUntil = Date.now() + REPROBE_MS;
    return null;
  }
}

/**
 * Batch a single-uint-returning view function (e.g. payoutDenominator, marketResolvedAt,
 * payoutNumerators, balanceOf) over many argument tuples — ONE eth_call via Multicall3, or individual
 * eth_calls as a fallback. Returns one value per argument tuple, aligned by index; null where a
 * particular call failed.
 */
export async function batchUint(
  provider: ethers.JsonRpcProvider,
  contract: ethers.Contract,
  fn: string,
  argsList: unknown[][],
): Promise<(bigint | null)[]> {
  if (argsList.length === 0) return [];
  const iface = contract.interface;
  const target = contract.target as string;
  const calls = argsList.map((args) => ({ target, callData: iface.encodeFunctionData(fn, args) }));

  const res = await tryMulticall(provider, calls);
  if (res) {
    return res.map((rd) => {
      if (!rd || rd === "0x") return null;
      try {
        return iface.decodeFunctionResult(fn, rd)[0] as bigint;
      } catch {
        return null;
      }
    });
  }

  // Fallback: individual eth_calls (Multicall3 not deployed here).
  const out: (bigint | null)[] = [];
  for (const args of argsList) {
    try {
      out.push((await contract.getFunction(fn).staticCall(...args)) as bigint);
    } catch {
      out.push(null);
    }
  }
  return out;
}
