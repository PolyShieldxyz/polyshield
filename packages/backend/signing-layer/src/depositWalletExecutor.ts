import { ethers } from "ethers";
import pino from "pino";
import { config } from "./config";

const logger = pino({ name: "deposit-wallet-executor" });

/**
 * Deposit-wallet execution abstraction.
 *
 * Post-April-2026, betting collateral and CTF shares live inside a per-account
 * deposit-wallet proxy, and every wallet action (redeemPositions, pUSD approvals,
 * offramp, transfers back to the Vault) must be executed by a relayer as a signed
 * `WALLET` batch — never as a direct EOA call. This interface hides that detail so
 * the redemption/settlement code runs the SAME path against the mock relayer
 * locally and the Polymarket builder relayer in production. Closes audit H2/H3.
 */
export interface WalletCall {
  target: string;
  value?: bigint;
  data: string;
}

export interface DepositWalletExecutor {
  /** Execute a single call as the deposit wallet. */
  execute(call: WalletCall): Promise<void>;
  /** Execute a batch of calls as the deposit wallet (atomic where supported). */
  executeBatch(calls: WalletCall[]): Promise<void>;
  /** Idempotent one-time approvals from the deposit wallet (pUSD → CTF exchange, pUSD → offramp). H3. */
  ensureApprovals(): Promise<void>;
  /** Human-readable name for logging. */
  readonly kind: string;
}

const ERC20_IFACE = new ethers.Interface([
  "function approve(address spender, uint256 amount) returns (bool)",
]);

/** Build the one-time pUSD approval batch from the deposit wallet (H3). */
function approvalCalls(): WalletCall[] {
  const calls: WalletCall[] = [];
  if (!config.pusdAddress) return calls;
  const spenders = [config.ctfAddress, config.offrampAddress].filter(
    (s): s is string => Boolean(s) && s !== ethers.ZeroAddress,
  );
  for (const spender of spenders) {
    calls.push({
      target: config.pusdAddress,
      value: 0n,
      data: ERC20_IFACE.encodeFunctionData("approve", [spender, ethers.MaxUint256]),
    });
  }
  return calls;
}

/**
 * Mock relayer executor — POSTs WALLET batches to the mock relayer endpoint, which
 * submits them on-chain to the MockDepositWallet proxy. Mirrors production.
 */
class MockRelayerExecutor implements DepositWalletExecutor {
  readonly kind = "mock-relayer";
  constructor(private readonly relayerUrl: string) {}

  async execute(call: WalletCall): Promise<void> {
    await this.executeBatch([call]);
  }

  async executeBatch(calls: WalletCall[]): Promise<void> {
    if (calls.length === 0) return;
    const body = {
      calls: calls.map((c) => ({
        target: c.target,
        value: (c.value ?? 0n).toString(),
        data: c.data,
      })),
    };
    const res = await fetch(`${this.relayerUrl}/relayer/wallet-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; txHash?: string };
    if (!res.ok || parsed.ok === false) {
      throw new Error(`mock relayer batch failed (HTTP ${res.status}): ${parsed.error ?? "unknown"}`);
    }
    logger.info({ calls: calls.length, txHash: parsed.txHash }, "mock relayer: WALLET batch submitted");
  }

  async ensureApprovals(): Promise<void> {
    const calls = approvalCalls();
    if (calls.length === 0) {
      logger.warn("ensureApprovals: no pUSD/spender config — skipping");
      return;
    }
    await this.executeBatch(calls);
    logger.info({ count: calls.length }, "ensureApprovals: deposit-wallet pUSD approvals set via mock relayer (H3)");
  }
}

/**
 * Production Polymarket relayer executor (deferred — see FC-4 / collateral-flow-audit H2).
 * Wraps @polymarket/builder-relayer-client WALLET batches. Intentionally a thin,
 * clearly-marked placeholder pending live-API validation; throws if invoked so the
 * gap is loud rather than silent.
 */
class PolymarketRelayerExecutor implements DepositWalletExecutor {
  readonly kind = "polymarket-relayer";
  constructor(private readonly relayerUrl: string) {}

  private notWired(): never {
    throw new Error(
      "PolymarketRelayerExecutor not yet wired — integrate @polymarket/builder-relayer-client " +
        `WALLET batches against ${this.relayerUrl} before mainnet (collateral-flow-audit.md H2/H3).`,
    );
  }

  async execute(): Promise<void> {
    this.notWired();
  }
  async executeBatch(): Promise<void> {
    this.notWired();
  }
  async ensureApprovals(): Promise<void> {
    logger.warn(
      { depositWallet: config.depositWalletAddress },
      "H3: production deposit-wallet pUSD approval not yet automated — set it via the Polymarket relayer before the first order",
    );
  }
}

/**
 * Legacy EOA executor — the deposit wallet is a plain EOA whose key we hold. Signs
 * each call directly. Kept as a fallback for the pre-proxy local setup.
 */
class EoaExecutor implements DepositWalletExecutor {
  readonly kind = "eoa";
  constructor(
    private readonly provider: ethers.JsonRpcProvider,
    private readonly wallet: ethers.Wallet,
  ) {}

  async execute(call: WalletCall): Promise<void> {
    const tx = await this.wallet.sendTransaction({
      to: call.target,
      value: call.value ?? 0n,
      data: call.data,
    });
    await tx.wait(1);
  }

  async executeBatch(calls: WalletCall[]): Promise<void> {
    // No atomic batch for an EOA — send sequentially.
    for (const c of calls) await this.execute(c);
  }

  async ensureApprovals(): Promise<void> {
    await this.executeBatch(approvalCalls());
  }
}

/**
 * Choose the executor from config:
 *   MOCK_RELAYER_URL set            → MockRelayerExecutor (local proxy + mock relayer)
 *   POLY_RELAYER_URL set            → PolymarketRelayerExecutor (production, deferred)
 *   DEPOSIT_WALLET_KEY set (legacy) → EoaExecutor
 */
export function getDepositWalletExecutor(
  provider: ethers.JsonRpcProvider,
): DepositWalletExecutor {
  if (config.mockRelayerUrl) return new MockRelayerExecutor(config.mockRelayerUrl);
  if (config.polyRelayerUrl) return new PolymarketRelayerExecutor(config.polyRelayerUrl);
  if (config.depositWalletKey) {
    return new EoaExecutor(provider, new ethers.Wallet(config.depositWalletKey, provider));
  }
  // No execution path configured — surface a clear no-op that logs loudly.
  logger.error(
    "No deposit-wallet executor configured (set MOCK_RELAYER_URL, POLY_RELAYER_URL, or DEPOSIT_WALLET_KEY). " +
      "Settlement/redemption deposit-wallet actions will fail.",
  );
  return new PolymarketRelayerExecutor(config.polyRelayerUrl || "");
}
