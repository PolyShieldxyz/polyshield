import { computePayoutPerShare } from "../redemptionHelpers";

describe("redemption pipeline helpers", () => {
  it("computes payout per share from CTF numerators", () => {
    expect(computePayoutPerShare([0n, 1n], 1_000_000n)).toBe(1);
    expect(computePayoutPerShare([0n, 500_000n], 1_000_000n)).toBe(500_000);
  });
});
