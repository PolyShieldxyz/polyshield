/**
 * FC-4 / FC-9: shared terminal-state → OperatorAttestation mapping.
 *
 * A market/limit order's terminal outcome maps onto exactly one terminal operator
 * attestation. This helper centralizes that mapping so the three call sites that
 * need it agree byte-for-byte:
 *   - submitFAKOrder        (synchronous fill-and-kill, orderBuilder.ts)
 *   - the user-channel websocket fill tracker (wsFillTracker.ts)
 *   - the tracker's REST reconcile backstop
 *
 * It lives in its own module (rather than orderBuilder.ts) to avoid an import cycle
 * between orderBuilder ↔ wsFillTracker. It depends only on the single-write,
 * idempotent attestation store, so calling it twice for the same bet is safe (the
 * second call returns the existing row without re-signing).
 *
 * Mapping (status is matched case-insensitively):
 *   matched / filled                                  → FILLED (0, 0)
 *   partial, strictly < expected_shares AND < bet     → PARTIAL (filled_shares, spent_amount)
 *   partial that actually consumed the whole position → FILLED (0, 0)   (Vault rejects a non-strict PARTIAL)
 *   anything else (cancelled / unmatched / expired-0) → FAILED (0, 0)
 */

import { ethers } from "ethers";
import pino from "pino";
import {
  ReportType,
  signAndStoreAttestation,
  getAttestationDomainParams,
} from "./attestationStore";

const logger = pino({ name: "terminal-attestation" });

/** Minimal bet identity needed to classify a strict-partial vs full fill. */
export interface TerminalBet {
  nullifier: string;
  expected_shares: bigint;
  bet_amount: bigint;
}

/**
 * Sign + persist the single terminal OperatorAttestation for a bet given the order's
 * terminal status and (for partials) the filled/spent amounts (1e6-scaled). Defensive:
 * logs and swallows on error rather than crashing the order/tracker path. Idempotent
 * via the single-write store.
 */
export async function attestTerminal(
  wallet: ethers.Wallet,
  bet: TerminalBet,
  status: string,
  filledShares: bigint,
  spentAmount: bigint,
): Promise<void> {
  const s = status.toLowerCase();

  let reportType: ReportType;
  let amountA = 0n;
  let amountB = 0n;

  if (s === "matched" || s === "filled") {
    reportType = ReportType.FILLED;
  } else if (s === "partial") {
    const fullyConsumed = filledShares >= bet.expected_shares || spentAmount >= bet.bet_amount;
    const strictPartial = filledShares > 0n && spentAmount > 0n && !fullyConsumed;
    if (strictPartial) {
      // partialFillCredit requires a strict partial (filled < expected, spent < bet).
      reportType = ReportType.PARTIAL;
      amountA = filledShares;
      amountB = spentAmount;
    } else if (fullyConsumed) {
      // A "partial" that bought the whole position is a FULL fill — attest FILLED so
      // the Vault doesn't reject a non-strict PARTIAL.
      reportType = ReportType.FILLED;
    } else {
      // Degenerate "partial" with no fill — treat as zero-fill (recoverable).
      reportType = ReportType.FAILED;
    }
  } else {
    // cancelled / unmatched / expired with zero fill → FOK-failure recovery path.
    reportType = ReportType.FAILED;
  }

  try {
    await signAndStoreAttestation(wallet, getAttestationDomainParams(), {
      nullifierOfBet: bet.nullifier,
      reportType,
      amountA,
      amountB,
    });
    logger.info(
      { nullifier: bet.nullifier, status: s, reportType, amountA: amountA.toString(), amountB: amountB.toString() },
      "terminal attestation signed + persisted",
    );
  } catch (err) {
    logger.error({ err, nullifier: bet.nullifier, reportType }, "attestTerminal: signAndStoreAttestation errored");
  }
}
