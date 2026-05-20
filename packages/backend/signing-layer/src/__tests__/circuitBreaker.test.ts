import { checkResponse } from "../circuitBreaker";

// Mock process.exit so we can test circuit breaker without dying
const mockExit = jest.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
  throw new Error(`process.exit(${code})`);
});

describe("circuitBreaker", () => {
  afterAll(() => {
    mockExit.mockRestore();
  });

  it("does not halt on 200", () => {
    expect(() => checkResponse(200, {})).not.toThrow();
  });

  it("halts on 403", () => {
    expect(() => checkResponse(403)).toThrow("process.exit(1)");
  });

  it("halts on ACCOUNT_FLAGGED error body", () => {
    expect(() => checkResponse(200, { error: "ACCOUNT_FLAGGED" })).toThrow("process.exit(1)");
  });

  it("halts on ACCOUNT_BANNED code", () => {
    expect(() => checkResponse(200, { code: "ACCOUNT_BANNED" })).toThrow("process.exit(1)");
  });

  it("does not halt on unknown error body", () => {
    expect(() => checkResponse(200, { error: "SOME_OTHER_ERROR" })).not.toThrow();
  });
});
