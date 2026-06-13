import { ethers } from "ethers";
import pino from "pino";
import { RelayClient, type DepositWalletCall } from "@polymarket/builder-relayer-client";
import { config } from "./config";
import { getViemWallet, getRelayerBuilderConfig, POLYGON_CHAIN_ID } from "./builderConfig";

const logger = pino({ name: "deposit-wallet-executor" });

// Window (seconds) for the relayer Batch EIP-712 deadline — long enough to tolerate
// signer/relayer clock skew and submission latency, short enough to bound replay.
const RELAY_DEADLINE_SECONDS = 300;

// The Polymarket relayer serializes WALLET actions per deposit wallet: a second batch submitted
// before the previous one has fully settled is rejected with HTTP 400 "wallet busy: active action
// exists". Back-to-back batches (redeem→offramp in settlement, offramp→sweep in reclaim) hit this,
// so retry with backoff until the prior action clears.
const WALLET_BUSY_MAX_RETRIES = 8;
const WALLET_BUSY_DELAY_MS = 5000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isWalletBusy(err: unknown): boolean {
  let s = "";
  try {
    s = JSON.stringify(err);
  } catch {
    /* circular — fall back to fields below */
  }
  const e = err as { message?: unknown; data?: { error?: unknown } } | null;
  s += ` ${String(e?.message ?? "")} ${String(e?.data?.error ?? "")}`;
  return /wallet busy|active action exists/i.test(s);
}

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
  /** Idempotent one-time approvals from the deposit wallet (USDC→onramp, pUSD→exchange, CTF→exchange). H3. */
  ensureApprovals(): Promise<void>;
  /** Human-readable name for logging. */
  readonly kind: string;
}

const ERC20_IFACE = new ethers.Interface([
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const ERC1155_IFACE = new ethers.Interface([
  "function setApprovalForAll(address operator, bool approved)",
]);

/**
 * Build the one-time Polymarket trading-enablement batch for the deposit wallet (H3).
 *
 * Polymarket settles in pUSD ("Polymarket USD"), and the vault funds the deposit wallet in
 * USDC.e (the vault can't hold pUSD — minting pUSD to a non-Polymarket account reverts, which
 * is why Vault.onramp.deposit failed). So the deposit wallet itself wraps USDC→pUSD via the
 * onramp, then trades in pUSD. The standing approvals it needs (all MaxUint256, set once):
 *   (a) USDC.e → onramp   — so `onramp.deposit(amount)` can pull USDC to mint pUSD.
 *   (b) pUSD   → exchange — so the CLOB exchange can pull pUSD collateral on a fill.
 *   (c) CTF setApprovalForAll → exchange — so positions can be sold / redeemed.
 * Without these the platform forces a manual "enable trading" signature. NOTE: neg-risk
 * (multi-outcome) markets also need the neg-risk exchange/adapter approved — add here if traded.
 */
function approvalCalls(): WalletCall[] {
  const calls: WalletCall[] = [];
  const exchange = config.ctfExchangeV2Address;

  // NOTE: the USDC→onramp approval is done per-wrap inside wrapUsdcToPusd (matching the
  // frontend batch), so it's not a standing approval here.
  // (b) pUSD → exchange (trading collateral).
  if (config.pusdAddress && exchange && exchange !== ethers.ZeroAddress) {
    calls.push({
      target: config.pusdAddress,
      value: 0n,
      data: ERC20_IFACE.encodeFunctionData("approve", [exchange, ethers.MaxUint256]),
    });
  }
  // (c) CTF setApprovalForAll → exchange (SELL / closePosition / redeem).
  if (config.ctfAddress && exchange && exchange !== ethers.ZeroAddress) {
    calls.push({
      target: config.ctfAddress,
      value: 0n,
      data: ERC1155_IFACE.encodeFunctionData("setApprovalForAll", [exchange, true]),
    });
  }
  return calls;
}

// The onramp's USDC→pUSD entrypoint, decoded from the live Polymarket "confirm deposit" batch
// (selector 0x62355638): wrap(token, account, amount) — pulls `amount` of `token` from `account`
// (via the approval below) and mints pUSD to it. NOT `deposit(uint256)`.
const ONRAMP_IFACE = new ethers.Interface([
  "function wrap(address token, address account, uint256 amount)",
]);

/**
 * Wrap `amount` (6dp USDC, already present in the deposit wallet) into pUSD, replicating the
 * exact 2-call batch the Polymarket frontend's "confirm deposit" signs:
 *   1. USDC.approve(onramp, amount)
 *   2. onramp.wrap(USDC, depositWallet, amount)   // mints pUSD to the deposit wallet
 * Submitted as one atomic WALLET batch via the relayer, signed by the deposit wallet's owner.
 * Only succeeds for a Polymarket-registered proxy (the deposit wallet), not the vault.
 */
export async function wrapUsdcToPusd(executor: DepositWalletExecutor, amount: bigint): Promise<void> {
  if (!config.onrampAddress || config.onrampAddress === ethers.ZeroAddress) {
    throw new Error("wrapUsdcToPusd: ONRAMP_ADDRESS not configured");
  }
  if (!config.usdcAddress) throw new Error("wrapUsdcToPusd: USDC_ADDRESS not configured");
  if (!config.depositWalletAddress) throw new Error("wrapUsdcToPusd: DEPOSIT_WALLET_ADDRESS not configured");
  await executor.executeBatch([
    {
      target: config.usdcAddress,
      value: 0n,
      data: ERC20_IFACE.encodeFunctionData("approve", [config.onrampAddress, amount]),
    },
    {
      target: config.onrampAddress,
      value: 0n,
      data: ONRAMP_IFACE.encodeFunctionData("wrap", [config.usdcAddress, config.depositWalletAddress, amount]),
    },
  ]);
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
      logger.warn("ensureApprovals: no exchange/USDC config — skipping");
      return;
    }
    await this.executeBatch(calls);
    logger.info({ count: calls.length }, "ensureApprovals: deposit-wallet pUSD approvals set via mock relayer (H3)");
  }
}

/**
 * Production Polymarket relayer executor. Wraps @polymarket/builder-relayer-client
 * `RelayClient` so deposit-wallet calls (redeemPositions, offramp, approvals) are submitted
 * as gas-free WALLET batches signed by the operator EOA (the deposit wallet's owner) and
 * mined by the Polymarket builder relayer. Closes audit H2/H3. The RelayClient + viem wallet
 * are cached at module scope (one authenticated client per process).
 */
class PolymarketRelayerExecutor implements DepositWalletExecutor {
  readonly kind = "polymarket-relayer";
  constructor(private readonly relayerUrl: string) {}

  private client(): RelayClient {
    return getRelayClient(this.relayerUrl);
  }

  private deadline(): string {
    return String(Math.floor(Date.now() / 1000) + RELAY_DEADLINE_SECONDS);
  }

  /** bigint `value` → string `value`; target/data pass through. */
  private toDepositWalletCalls(calls: WalletCall[]): DepositWalletCall[] {
    return calls.map((c) => ({
      target: c.target,
      value: (c.value ?? 0n).toString(),
      data: c.data,
    }));
  }

  async execute(call: WalletCall): Promise<void> {
    await this.executeBatch([call]);
  }

  async executeBatch(calls: WalletCall[]): Promise<void> {
    if (calls.length === 0) return;
    if (!config.depositWalletAddress) {
      throw new Error("PolymarketRelayerExecutor: DEPOSIT_WALLET_ADDRESS not set");
    }
    for (let attempt = 1; ; attempt++) {
      try {
        const resp = await this.client().executeDepositWalletBatch(
          this.toDepositWalletCalls(calls),
          config.depositWalletAddress,
          this.deadline(),
        );
        // wait() resolves to the mined RelayerTransaction, or undefined if the relayer tx hit
        // its fail state / timed out. Treat undefined as a hard failure and THROW — callers
        // (redemptionPipeline) depend on a throw to halt; a silent no-throw would let the
        // post-batch pUSD balance-delta read compute 0 and skip the offramp (lost funds).
        const mined = await resp.wait();
        if (!mined) {
          throw new Error(
            `polymarket relayer WALLET batch failed or timed out (txId=${resp.transactionID}, state=${resp.state})`,
          );
        }
        logger.info(
          { calls: calls.length, txId: mined.transactionID, txHash: mined.transactionHash, state: mined.state },
          "polymarket relayer: WALLET batch mined",
        );
        return;
      } catch (err) {
        // The relayer serializes actions per wallet; a prior batch may not have cleared yet.
        // Back off and retry rather than failing the whole reclaim/settlement.
        if (isWalletBusy(err) && attempt < WALLET_BUSY_MAX_RETRIES) {
          logger.warn(
            { attempt, maxRetries: WALLET_BUSY_MAX_RETRIES, delayMs: WALLET_BUSY_DELAY_MS },
            "polymarket relayer: wallet busy (active action exists) — waiting for it to clear, then retrying",
          );
          await sleep(WALLET_BUSY_DELAY_MS);
          continue;
        }
        throw err;
      }
    }
  }

  async ensureApprovals(): Promise<void> {
    if (!config.depositWalletAddress) {
      logger.warn("ensureApprovals: DEPOSIT_WALLET_ADDRESS not set — skipping");
      return;
    }
    const client = this.client();

    // (a) Deploy the deposit wallet (WALLET-CREATE) if it isn't yet. Gas-free and idempotent;
    //     a WALLET batch / POLY_1271 order against an undeployed proxy would fail.
    try {
      const deployed = await client.getDeployed(config.depositWalletAddress, "WALLET");
      if (!deployed) {
        logger.info(
          { depositWallet: config.depositWalletAddress },
          "deposit wallet not deployed — deploying via relayer (WALLET-CREATE)",
        );
        const tx = await client.deployDepositWallet();
        await tx.wait();
        logger.info("deposit wallet deployed");
      }
    } catch (err) {
      // getDeployed may be eventually-consistent and a redundant deploy reverts; log and
      // continue — the approval batch below reverts loudly if the wallet is truly undeployed.
      logger.warn({ err }, "ensureApprovals: deploy check/deploy step failed (continuing)");
    }

    // (b) Trading enablement: USDC.e allowance + CTF setApprovalForAll → exchange (see approvalCalls).
    const calls = approvalCalls();
    if (calls.length === 0) {
      logger.warn("ensureApprovals: no approval calls to submit — skipping");
      return;
    }
    await this.executeBatch(calls);
    logger.info({ count: calls.length }, "ensureApprovals: deposit-wallet approvals set via Polymarket relayer (H3)");
  }
}

// Cached RelayClient — one authenticated builder-relayer client per process. The viem wallet
// (operator EOA) and BuilderConfig are themselves cached in builderConfig.ts. signing-layer and
// builder-relayer-client both resolve viem@2.50.4, so the WalletClient type matches directly.
let _relayClient: RelayClient | null = null;
function getRelayClient(relayerUrl: string): RelayClient {
  if (_relayClient) return _relayClient;
  _relayClient = new RelayClient(
    relayerUrl,
    POLYGON_CHAIN_ID,
    getViemWallet(),
    getRelayerBuilderConfig(),
  );
  return _relayClient;
}

/**
 * Predict the deposit wallet address (CREATE2) for the operator EOA via the builder relayer.
 * Requires POLY_RELAYER_URL. Used by the startup derive-and-assert guard and the setup CLI.
 */
export async function deriveDepositWalletAddress(): Promise<string> {
  if (!config.polyRelayerUrl) {
    throw new Error("deriveDepositWalletAddress requires POLY_RELAYER_URL to be set");
  }
  return getRelayClient(config.polyRelayerUrl).deriveDepositWalletAddress();
}

/** The cached production RelayClient (requires POLY_RELAYER_URL). Exposed for the setup CLI. */
export function getProductionRelayClient(): RelayClient {
  if (!config.polyRelayerUrl) {
    throw new Error("getProductionRelayClient requires POLY_RELAYER_URL to be set");
  }
  return getRelayClient(config.polyRelayerUrl);
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
 * Last-resort executor when nothing is configured — throws loudly on any deposit-wallet
 * action instead of constructing a RelayClient against an empty URL. Surfaces the
 * misconfiguration at the call site rather than at relayer-client construction.
 */
class UnconfiguredExecutor implements DepositWalletExecutor {
  readonly kind = "unconfigured";
  private fail(): never {
    throw new Error(
      "No deposit-wallet executor configured — set MOCK_RELAYER_URL (dev) or POLY_RELAYER_URL " +
        "(prod) or DEPOSIT_WALLET_KEY (legacy). Deposit-wallet actions cannot run.",
    );
  }
  async execute(): Promise<void> {
    this.fail();
  }
  async executeBatch(): Promise<void> {
    this.fail();
  }
  async ensureApprovals(): Promise<void> {
    logger.error(
      "No deposit-wallet executor configured (set MOCK_RELAYER_URL, POLY_RELAYER_URL, or DEPOSIT_WALLET_KEY). " +
        "Settlement/redemption deposit-wallet actions will fail.",
    );
  }
}

/**
 * Choose the executor from config:
 *   MOCK_RELAYER_URL set            → MockRelayerExecutor (local proxy + mock relayer)
 *   POLY_RELAYER_URL set            → PolymarketRelayerExecutor (production builder relayer)
 *   DEPOSIT_WALLET_KEY set (legacy) → EoaExecutor
 *   otherwise                       → UnconfiguredExecutor (throws on use)
 */
export function getDepositWalletExecutor(
  provider: ethers.JsonRpcProvider,
): DepositWalletExecutor {
  if (config.mockRelayerUrl) return new MockRelayerExecutor(config.mockRelayerUrl);
  if (config.polyRelayerUrl) return new PolymarketRelayerExecutor(config.polyRelayerUrl);
  if (config.depositWalletKey) {
    return new EoaExecutor(provider, new ethers.Wallet(config.depositWalletKey, provider));
  }
  return new UnconfiguredExecutor();
}
