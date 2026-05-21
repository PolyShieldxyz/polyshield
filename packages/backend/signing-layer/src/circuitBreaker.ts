import pino from "pino";
import { stopHeartbeat } from "./heartbeat";

const logger = pino({ name: "circuit-breaker" });

let halted = false;

export function isHalted(): boolean {
  return halted;
}

// Called when a 403 or account-flagged response is received.
// Clears the heartbeat and exits the process so the operator is paged.
export function halt(reason: string): never {
  logger.error({ reason }, "CIRCUIT BREAKER TRIGGERED — halting all signing");
  halted = true;
  stopHeartbeat();
  // Hard exit — do not allow any further signing after a ban signal
  process.exit(1);
}

export function checkResponse(status: number, body?: unknown): void {
  if (status === 403) {
    halt("HTTP 403 — Polymarket account access denied");
  }
  // Check for account-flagged error codes in the response body
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (b["error"] === "ACCOUNT_FLAGGED" || b["code"] === "ACCOUNT_BANNED") {
      halt(`Account flagged: ${JSON.stringify(b)}`);
    }
  }
}
