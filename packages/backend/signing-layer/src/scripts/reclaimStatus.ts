/**
 * Reclaim status — READ-ONLY diagnostic for stranded collateral.
 *
 * Reports where the vault's collateral actually is, so you can see why a withdrawal is
 * blocked ("Vault funds are currently deployed to Polymarket"). The withdrawal UI guards on
 * the Vault's USDC.e balance; if that is short, the funds are sitting in the Polymarket
 * deposit wallet as pUSD (JIT residual / settled winnings) and/or unwrapped USDC.e.
 *
 * This script makes NO transactions. Run it before reclaimToVault to know what to reclaim:
 *
 *   pnpm --filter @polyshield/signing-layer reclaim:status
 *
 * Requires (read-only): POLYGON_RPC_URL, VAULT_CONTRACT_ADDRESS, USDC_ADDRESS, PUSD_ADDRESS,
 * DEPOSIT_WALLET_ADDRESS. (No private key needed.)
 */
import { ethers } from "ethers";
import { config } from "../config";
import { RetryingJsonRpcProvider } from "../logScan";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];
const VAULT_ABI = ["function deployedToPolymarket() view returns (uint256)"];

function fmt(v: bigint, decimals = 6): string {
  return `${ethers.formatUnits(v, decimals)} (${v.toString()} raw)`;
}

async function main(): Promise<void> {
  const provider = new RetryingJsonRpcProvider(config.polygonRpcUrl);

  const out = process.stdout;
  out.write("\n===== Polyshield reclaim status (read-only) =====\n");
  out.write(`Vault:          ${config.vaultContractAddress}\n`);
  out.write(`Deposit wallet: ${config.depositWalletAddress || "(unset!)"}\n`);
  out.write(`USDC.e:         ${config.usdcAddress || "(unset!)"}\n`);
  out.write(`pUSD:           ${config.pusdAddress || "(unset!)"}\n`);
  out.write(`Offramp:        ${config.offrampAddress || "(unset!)"}\n\n`);

  if (!config.depositWalletAddress) throw new Error("DEPOSIT_WALLET_ADDRESS not set — cannot read balances");
  if (!config.usdcAddress || !config.pusdAddress) throw new Error("USDC_ADDRESS / PUSD_ADDRESS not set");

  const usdc = new ethers.Contract(config.usdcAddress, ERC20_ABI, provider);
  const pusd = new ethers.Contract(config.pusdAddress, ERC20_ABI, provider);
  const vault = new ethers.Contract(config.vaultContractAddress, VAULT_ABI, provider);

  const [vaultUsdc, dwUsdc, dwPusd, deployed] = await Promise.all([
    usdc.balanceOf(config.vaultContractAddress) as Promise<bigint>,
    usdc.balanceOf(config.depositWalletAddress) as Promise<bigint>,
    pusd.balanceOf(config.depositWalletAddress) as Promise<bigint>,
    vault.deployedToPolymarket().catch(() => 0n) as Promise<bigint>,
  ]);

  out.write("Balances\n");
  out.write(`  Vault USDC.e (pays withdrawals):     ${fmt(vaultUsdc)}\n`);
  out.write(`  Deposit-wallet USDC.e (idle):        ${fmt(dwUsdc)}\n`);
  out.write(`  Deposit-wallet pUSD (needs offramp): ${fmt(dwPusd)}\n`);
  out.write(`  Vault.deployedToPolymarket (acct):   ${fmt(deployed)}\n\n`);

  const reclaimableNow = dwUsdc;          // plain ERC-20 transfer — zero ABI risk
  const reclaimableViaOfframp = dwPusd;   // needs the (unverified) offramp call

  out.write("Reclaimable\n");
  out.write(`  → USDC.e transferable to Vault NOW (safe):     ${fmt(reclaimableNow)}\n`);
  out.write(`  → pUSD recoverable VIA OFFRAMP (verify ABI!):  ${fmt(reclaimableViaOfframp)}\n\n`);

  if (dwPusd > 0n) {
    out.write(
      "NOTE: the pUSD above is recovered via the verified CollateralOfframp call\n" +
        "      unwrap(USDC.e, depositWallet, amount) (selector 0x8cc7104f) — run reclaim:to-vault\n" +
        "      with --offramp to convert it, then it sweeps to the Vault.\n",
    );
  }
  out.write("Next: reclaim:to-vault --usdc-only (safe; idle USDC.e)  |  --offramp (also converts pUSD)\n\n");
}

main().catch((err) => {
  process.stderr.write(`reclaim status failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
