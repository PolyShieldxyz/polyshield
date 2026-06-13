/**
 * Reclaim stranded collateral from the Polymarket deposit wallet back into the Vault, so the
 * Vault can pay withdrawals again. This closes the documented FC-7 gap: JIT funding wraps Vault
 * USDC.e -> pUSD in the deposit wallet and never sweeps the residual back, and settlement only
 * offramps the exact CTF-redeemed amount. Idle pUSD / USDC.e therefore has no route home.
 *
 * Operator-run (signs as the vault EOA, executes deposit-wallet calls via the same relayer path
 * as settlement). MAKES TRANSACTIONS — read the modes:
 *
 *   pnpm --filter @polyshield/signing-layer reclaim:to-vault -- --dry-run
 *       Print what each mode would move. No transactions.
 *
 *   pnpm --filter @polyshield/signing-layer reclaim:to-vault -- --usdc-only        (DEFAULT, SAFE)
 *       Transfer any IDLE USDC.e in the deposit wallet -> Vault, then acknowledgePolymarketReturn.
 *       Pure ERC-20 transfer — no offramp, zero ABI risk. Recovers everything already unwrapped.
 *
 *   pnpm --filter @polyshield/signing-layer reclaim:to-vault -- --offramp
 *       ALSO offramp deposit-wallet pUSD -> USDC.e first, then sweep as above. Uses the VERIFIED
 *       CollateralOfframp call `unwrap(address _asset, address _to, uint256 _amount)` (selector
 *       0x8cc7104f): pulls pUSD from the deposit wallet and returns USDC.e to it. The deposit-wallet
 *       WALLET batch is atomic, so any failure reverts cleanly (no partial fund movement).
 *
 * Flags: --dry-run, --usdc-only (default), --offramp, --max <usdc-decimal> (cap the amount).
 * Requires: VAULT_EOA_PRIVATE_KEY (== signingLayerOperator), POLYGON_RPC_URL,
 * VAULT_CONTRACT_ADDRESS, USDC_ADDRESS, PUSD_ADDRESS, DEPOSIT_WALLET_ADDRESS, OFFRAMP_ADDRESS
 * (for --offramp), and a relayer (POLY_RELAYER_URL / MOCK_RELAYER_URL / DEPOSIT_WALLET_KEY).
 */
import { ethers } from "ethers";
import pino from "pino";
import { config } from "../config";
import { RetryingJsonRpcProvider } from "../logScan";
import { signingLayerNonceManager } from "../nonceManager";
import { getDepositWalletExecutor, WalletCall } from "../depositWalletExecutor";

const logger = pino({ name: "reclaim-to-vault" });

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
];
const VAULT_ABI = [
  "function deployedToPolymarket() view returns (uint256)",
  "function acknowledgePolymarketReturn(uint256 amount) external",
];

const erc20 = new ethers.Interface(ERC20_ABI);

function fmt(v: bigint): string {
  return `${ethers.formatUnits(v, 6)} (${v.toString()} raw)`;
}

// VERIFIED against the live CollateralOfframp (0x2957922Eb93258b93368531d39fAcCA3B4dC5854):
//   unwrap(address _asset, address _to, uint256 _amount)   selector 0x8cc7104f
// It pulls `_amount` pUSD from msg.sender (the deposit wallet) and sends `_amount` of `_asset`
// (= USDC.e) to `_to`, burning the pUSD. So: approve pUSD→offramp, then unwrap USDC.e back to
// the deposit wallet; Phase B then sweeps the resulting USDC.e to the Vault.
const OFFRAMP_IFACE = new ethers.Interface(["function unwrap(address _asset, address _to, uint256 _amount)"]);

/** [approve pUSD→offramp, unwrap pUSD→USDC.e into the deposit wallet]. */
function offrampCalls(amount: bigint): WalletCall[] {
  return [
    { target: config.pusdAddress, value: 0n, data: erc20.encodeFunctionData("approve", [config.offrampAddress, amount]) },
    { target: config.offrampAddress, value: 0n, data: OFFRAMP_IFACE.encodeFunctionData("unwrap", [config.usdcAddress, config.depositWalletAddress, amount]) },
  ];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const doOfframp = argv.includes("--offramp");
  const maxIdx = argv.indexOf("--max");
  const maxCap = maxIdx >= 0 && argv[maxIdx + 1] ? ethers.parseUnits(argv[maxIdx + 1], 6) : null;

  if (!config.depositWalletAddress) throw new Error("DEPOSIT_WALLET_ADDRESS not set");
  if (!config.usdcAddress || !config.pusdAddress) throw new Error("USDC_ADDRESS / PUSD_ADDRESS not set");

  const provider = new RetryingJsonRpcProvider(config.polygonRpcUrl);
  const operator = new ethers.Wallet(config.vaultEoaPrivateKey, provider);
  const usdcRo = new ethers.Contract(config.usdcAddress, ERC20_ABI, provider);
  const pusdRo = new ethers.Contract(config.pusdAddress, ERC20_ABI, provider);
  const vault = new ethers.Contract(config.vaultContractAddress, VAULT_ABI, operator);
  const executor = getDepositWalletExecutor(provider);

  const dwPusd: bigint = await pusdRo.balanceOf(config.depositWalletAddress);
  const dwUsdcBefore: bigint = await usdcRo.balanceOf(config.depositWalletAddress);
  logger.info({ dwPusd: dwPusd.toString(), dwUsdc: dwUsdcBefore.toString(), doOfframp, dryRun }, "reclaim: starting state");

  if (dryRun) {
    process.stdout.write(`\n[dry-run] deposit-wallet pUSD:   ${fmt(dwPusd)}\n`);
    process.stdout.write(`[dry-run] deposit-wallet USDC.e: ${fmt(dwUsdcBefore)}\n`);
    process.stdout.write(doOfframp
      ? `[dry-run] would: offramp ${fmt(dwPusd)} pUSD via unwrap() -> USDC.e, then sweep all USDC.e -> Vault + acknowledge.\n\n`
      : `[dry-run] would: transfer ${fmt(maxCap && maxCap < dwUsdcBefore ? maxCap : dwUsdcBefore)} idle USDC.e -> Vault + acknowledge (no offramp).\n\n`);
    return;
  }

  // Phase A (optional): offramp pUSD -> USDC.e inside the deposit wallet.
  if (doOfframp && dwPusd > 0n) {
    if (!config.offrampAddress || config.offrampAddress === ethers.ZeroAddress) throw new Error("OFFRAMP_ADDRESS not set");
    const amt = maxCap && maxCap < dwPusd ? maxCap : dwPusd;
    logger.info({ amount: amt.toString() },
      "reclaim: OFFRAMP pUSD->USDC.e via verified unwrap() WALLET batch (atomic)");
    await executor.executeBatch(offrampCalls(amt));
    logger.info("reclaim: offramp batch mined");
  }

  // Phase B: sweep the deposit wallet's USDC.e -> Vault.
  const dwUsdc: bigint = await usdcRo.balanceOf(config.depositWalletAddress);
  const sweep = maxCap && maxCap < dwUsdc ? maxCap : dwUsdc;
  if (sweep === 0n) {
    logger.warn("reclaim: no idle USDC.e in the deposit wallet to sweep — nothing to do");
    return;
  }
  logger.info({ amount: sweep.toString() }, "reclaim: transferring USDC.e deposit-wallet -> Vault");
  await executor.execute({
    target: config.usdcAddress,
    value: 0n,
    data: erc20.encodeFunctionData("transfer", [config.vaultContractAddress, sweep]),
  });
  logger.info({ amount: sweep.toString() }, "reclaim: USDC.e now in Vault");

  // Phase C: acknowledge so deployedToPolymarket decrements (clamped — never underflow).
  const deployed: bigint = await vault.deployedToPolymarket();
  const ack = sweep < deployed ? sweep : deployed;
  if (ack > 0n) {
    const tx = await signingLayerNonceManager.send(provider, operator, (nonce) =>
      vault.acknowledgePolymarketReturn(ack, { nonce }),
    );
    await tx.wait(1);
    logger.info({ ack: ack.toString(), txHash: tx.hash }, "reclaim: acknowledgePolymarketReturn confirmed");
  }

  const vaultUsdc: bigint = await usdcRo.balanceOf(config.vaultContractAddress);
  process.stdout.write(`\nReclaim complete. Vault USDC.e now: ${fmt(vaultUsdc)} — retry the withdrawal.\n\n`);
}

main().catch((err) => {
  process.stderr.write(`reclaim failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
