import { createApp } from "../api";

const supertest = require("supertest");

// Mock the relayer module so we don't need a live RPC
jest.mock("../relayer", () => ({
  relayAuthorizeBet: jest.fn().mockResolvedValue("0xabc"),
  relayCreditSettlement: jest.fn().mockResolvedValue("0xabc"),
  relayWithdraw: jest.fn().mockResolvedValue("0xabc"),
  relayBetCancellationCredit: jest.fn().mockResolvedValue("0xabc"),
  relayNACancellationCredit: jest.fn().mockResolvedValue("0xabc"),
}));

describe("proof-relay API", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  it("GET /health returns 200", async () => {
    const res = await supertest(app).get("/health");
    expect(res.status).toBe(200);
  });

  it("POST /relay/bet returns txHash", async () => {
    const res = await supertest(app)
      .post("/relay/bet")
      .send({ proof: "0xproof", inputs: { merkle_root: "0x1" } });
    expect(res.status).toBe(200);
    expect(res.body.txHash).toBe("0xabc");
  });

  it("POST /relay/bet returns 400 without required fields", async () => {
    const res = await supertest(app).post("/relay/bet").send({});
    expect(res.status).toBe(400);
  });

  it("POST /relay/settlement returns txHash", async () => {
    const res = await supertest(app)
      .post("/relay/settlement")
      .send({ proof: "0xproof", inputs: {} });
    expect(res.status).toBe(200);
    expect(res.body.txHash).toBe("0xabc");
  });

  it("POST /relay/withdrawal returns 400 without recipientAddress", async () => {
    const res = await supertest(app)
      .post("/relay/withdrawal")
      .send({ proof: "0xproof", inputs: {} });
    expect(res.status).toBe(400);
  });

  it("POST /relay/withdrawal returns txHash with all fields", async () => {
    const res = await supertest(app)
      .post("/relay/withdrawal")
      .send({ proof: "0xproof", inputs: {}, recipientAddress: "0xRecip" });
    expect(res.status).toBe(200);
    expect(res.body.txHash).toBe("0xabc");
  });

  it("POST /relay/bet-cancel returns txHash", async () => {
    const res = await supertest(app)
      .post("/relay/bet-cancel")
      .send({ proof: "0xproof", inputs: {} });
    expect(res.status).toBe(200);
  });

  it("POST /relay/na-cancel returns txHash", async () => {
    const res = await supertest(app)
      .post("/relay/na-cancel")
      .send({ proof: "0xproof", inputs: {} });
    expect(res.status).toBe(200);
  });

  it("does not include source IP in logs", () => {
    // Verify the api.ts source does not log req.ip, req.socket.remoteAddress,
    // or x-forwarded-for — these are redacted in index.ts pino config
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "../api.ts"),
      "utf-8"
    );
    expect(src).not.toMatch(/req\.ip/);
    expect(src).not.toMatch(/remoteAddress/);
    expect(src).not.toMatch(/x-forwarded-for/);
  });
});
