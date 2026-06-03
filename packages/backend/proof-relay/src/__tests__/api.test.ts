import { createApp } from "../api";

const supertest = require("supertest");

// Mock the relayer module so we don't need a live RPC
jest.mock("../relayer", () => ({
  relayAuthorizeBet: jest.fn().mockResolvedValue("0xabc"),
  relayCreditSettlement: jest.fn().mockResolvedValue("0xabc"),
  relayWithdraw: jest.fn().mockResolvedValue("0xabc"),
  relayBetCancellationCredit: jest.fn().mockResolvedValue("0xabc"),
  relayNACancellationCredit: jest.fn().mockResolvedValue("0xabc"),
  relayClosePosition: jest.fn().mockResolvedValue("0xabc"),
  relayPartialFillCredit: jest.fn().mockResolvedValue("0xabc"),
}));

// API-003: valid public-input fixtures. HEX32 = 0x + 64 hex chars; numeric fields
// are 1e6-scaled decimal strings; proof is a 0x hex blob.
const H = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const PROOF = "0x" + "ab".repeat(32);

const betInputs = {
  merkle_root: H(1),
  nullifier: H(2),
  new_commitment: H(3),
  bet_amount: "1000000",
  price: "500000",
  expected_shares: "2000000",
  market_id: H(4),
  outcome_side: "0",
  position_id: H(5),
};
const settlementInputs = {
  merkle_root: H(1),
  nullifier: H(2),
  new_commitment: H(3),
  nullifier_of_bet: H(6),
  market_id: H(4),
  total_credit: "1000000",
};
const withdrawalInputs = {
  merkle_root: H(1),
  nullifier: H(2),
  withdrawal_amount: "1000000",
  recipient_hash: H(7),
  new_commitment: H(3),
};
const fourField = {
  merkle_root: H(1),
  nullifier: H(2),
  new_commitment: H(3),
  nullifier_of_bet: H(6),
};
const naCancelInputs = { ...fourField, market_id: H(4) };

describe("proof-relay API", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  it("GET /health returns 200", async () => {
    const res = await supertest(app).get("/health");
    expect(res.status).toBe(200);
  });

  it("POST /relay/bet returns txHash with valid inputs", async () => {
    const res = await supertest(app)
      .post("/relay/bet")
      .send({ proof: PROOF, inputs: betInputs });
    expect(res.status).toBe(200);
    expect(res.body.txHash).toBe("0xabc");
  });

  it("POST /relay/bet returns 400 without required fields", async () => {
    const res = await supertest(app).post("/relay/bet").send({});
    expect(res.status).toBe(400);
  });

  it("POST /relay/bet returns 400 with malformed inputs (API-003)", async () => {
    const res = await supertest(app)
      .post("/relay/bet")
      .send({ proof: PROOF, inputs: { ...betInputs, merkle_root: "0x1" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid inputs");
  });

  it("POST /relay/bet returns 400 with non-hex proof (API-003)", async () => {
    const res = await supertest(app)
      .post("/relay/bet")
      .send({ proof: "0xnothex", inputs: betInputs });
    expect(res.status).toBe(400);
  });

  it("POST /relay/settlement returns txHash with valid inputs", async () => {
    const res = await supertest(app)
      .post("/relay/settlement")
      .send({ proof: PROOF, inputs: settlementInputs });
    expect(res.status).toBe(200);
    expect(res.body.txHash).toBe("0xabc");
  });

  it("POST /relay/settlement returns 400 with empty inputs (API-003)", async () => {
    const res = await supertest(app)
      .post("/relay/settlement")
      .send({ proof: PROOF, inputs: {} });
    expect(res.status).toBe(400);
  });

  it("POST /relay/withdrawal returns 400 without recipientAddress", async () => {
    const res = await supertest(app)
      .post("/relay/withdrawal")
      .send({ proof: PROOF, inputs: withdrawalInputs });
    expect(res.status).toBe(400);
  });

  it("POST /relay/withdrawal returns txHash with all fields", async () => {
    const res = await supertest(app)
      .post("/relay/withdrawal")
      .send({
        proof: PROOF,
        inputs: withdrawalInputs,
        recipientAddress: "0x" + "11".repeat(20),
      });
    expect(res.status).toBe(200);
    expect(res.body.txHash).toBe("0xabc");
  });

  it("POST /relay/bet-cancel returns txHash", async () => {
    const res = await supertest(app)
      .post("/relay/bet-cancel")
      .send({ proof: PROOF, inputs: fourField });
    expect(res.status).toBe(200);
  });

  it("POST /relay/na-cancel returns txHash", async () => {
    const res = await supertest(app)
      .post("/relay/na-cancel")
      .send({ proof: PROOF, inputs: naCancelInputs });
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
