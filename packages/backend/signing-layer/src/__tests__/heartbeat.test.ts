import { startHeartbeat, stopHeartbeat } from "../heartbeat.js";

describe("heartbeat", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    stopHeartbeat();
    jest.useRealTimers();
  });

  it("calls sendHeartbeat on the 5-second interval", () => {
    const sendHeartbeat = jest.fn().mockResolvedValue("hb-123");
    startHeartbeat(sendHeartbeat);

    jest.advanceTimersByTime(5000);
    expect(sendHeartbeat).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(5000);
    expect(sendHeartbeat).toHaveBeenCalledTimes(2);
  });

  it("stops calling after stopHeartbeat", () => {
    const sendHeartbeat = jest.fn().mockResolvedValue("hb-123");
    startHeartbeat(sendHeartbeat);
    jest.advanceTimersByTime(5000);
    expect(sendHeartbeat).toHaveBeenCalledTimes(1);

    stopHeartbeat();
    jest.advanceTimersByTime(10000);
    expect(sendHeartbeat).toHaveBeenCalledTimes(1);
  });

  it("does not log env var values", () => {
    // heartbeat.ts should not reference process.env values
    const src = require("fs").readFileSync(require("path").join(__dirname, "../heartbeat.ts"), "utf-8");
    expect(src).not.toMatch(/process\.env/);
  });
});
