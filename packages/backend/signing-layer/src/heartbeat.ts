import pino from "pino";

const logger = pino({ name: "heartbeat" });

let heartbeatId = "";
let intervalHandle: ReturnType<typeof setInterval> | null = null;

// sendHeartbeat is injected so the clob client instance can be passed in
export function startHeartbeat(sendHeartbeat: () => Promise<string>): void {
  intervalHandle = setInterval(async () => {
    try {
      heartbeatId = await sendHeartbeat();
      logger.debug({ heartbeatId }, "Heartbeat sent");
    } catch (err) {
      logger.error({ err }, "Heartbeat failed");
    }
  }, 5000);
}

export function stopHeartbeat(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
