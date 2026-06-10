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
 * Mapping (L3 — by the ACTUAL fill vs the committed bet, NOT the status string). The
 * committed expected_shares/bet_amount are an upper bound (the on-chain debit at authorizeBet);
 * the real CLOB fill can be smaller (tick round-up, budget/lag downsizing, book depth), so a
 * short fill must be reconciled to what was truly bought or settlement over-credits the pool.
 *   filled <= 0                                → FAILED (0, 0)                    (reclaim whole stake)
 *   filled >= expected_shares − DUST           → FILLED (0, 0)                    (full fill; price-improvement surplus → pool, FC-4 Q4)
 *   0 < filled < expected_shares − DUST        → PARTIAL (filled, min(spent, bet)) (reconcile to actuals via partialFillCredit)
 */

import { ethers } from "ethers";
import pino from "pino";
import {
  ReportType,
  signAndStoreAttestation,
  getAttestationDomainParams,
} from "./attestationStore";

const logger = pino({ name: "terminal-attestation" });

/**
 * Sub-share dust tolerance (0.01 share, 1e6-scaled). A fill within DUST of the committed
 * expected_shares is treated as a full fill, so benign tick/rounding differences between the
 * proof-time estimate and the executed size don't force a needless PARTIAL (and its extra
 * on-chain reconciliation step). The resulting over-credit is bounded by DUST × payout (≤ $0.01).
 */
const DUST = 10_000n;

/** Minimal bet identity needed to classify a strict-partial vs full fill. */
export interface TerminalBet {
  nullifier: string;
  expected_shares: bigint;
  bet_amount: bigint;
  /**
   * Order side. BUY (default) = a bet entry → FILLED/FAILED/PARTIAL. SELL = a position close
   * (FC-1) → SOLD (reportType 4) on any fill; a zero fill produces NO attestation.
   */
  side?: "BUY" | "SELL";
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

  // FC-1 position close (SELL): a fill attests SOLD (reportType 4). amountA = cumulative shares sold
  // (snapped up to expected_shares within DUST so a near-full close completes to CLOSED_CREDITED),
  // amountB = proceeds (already conservative — a SELL fills at ≥ its limit). A ZERO fill produces NO
  // attestation: the position is unchanged and must NOT be marked FAILED (that path reclaims the
  // whole bet stake via betCancellationCredit, which would be wrong for an unfilled close).
  if (bet.side === "SELL") {
    if (filledShares <= 0n) {
      logger.info({ nullifier: bet.nullifier, status: s }, "SELL close: zero fill — no attestation, position unchanged");
      return;
    }
    const soldShares = filledShares + DUST >= bet.expected_shares ? bet.expected_shares : filledShares;
    try {
      await signAndStoreAttestation(wallet, getAttestationDomainParams(), {
        nullifierOfBet: bet.nullifier,
        reportType: ReportType.SOLD,
        amountA: soldShares,
        amountB: spentAmount, // proceeds
      });
      logger.info(
        { nullifier: bet.nullifier, status: s, reportType: ReportType.SOLD, amountA: soldShares.toString(), amountB: spentAmount.toString() },
        "SELL close terminal attestation signed + persisted",
      );
    } catch (err) {
      logger.error({ err, nullifier: bet.nullifier }, "attestTerminal(SELL): signAndStoreAttestation errored");
    }
    return;
  }

  let reportType: ReportType;
  let amountA = 0n;
  let amountB = 0n;

  // L3: classify by the ACTUAL fill against the committed bet, not the status string. FOK
  // returns "matched" even when budgetedBuyOrder downsized the order, so a status-only mapping
  // would attest FILLED for a short fill and the settlement credit would exceed the shares held.
  if (filledShares <= 0n) {
    // No shares acquired (unmatched / expired / cancelled-with-no-fill / FOK miss) → fully
    // recoverable; the user reclaims the whole stake via betCancellationCredit.
    reportType = ReportType.FAILED;
  } else if (filledShares + DUST >= bet.expected_shares) {
    // Full fill on shares (within dust). Settlement on the committed expected_shares is exact;
    // any unspent stake from price improvement is surplus that accrues to the pool (FC-4 Q4).
    reportType = ReportType.FILLED;
  } else {
    // Genuine short fill: fewer shares than committed. Reconcile to actuals via partialFillCredit
    // (refund bet_amount − spent, normalize expected_shares := filled). Clamp spent to the
    // committed bet_amount — the on-chain debit and the Vault's bound (B-relax allows spent == bet).
    reportType = ReportType.PARTIAL;
    amountA = filledShares;
    amountB = spentAmount <= bet.bet_amount ? spentAmount : bet.bet_amount;
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
