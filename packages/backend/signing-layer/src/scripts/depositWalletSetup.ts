/**
 * Deposit-wallet setup CLI — one-time operator-run bootstrap for the production Polymarket
 * integration. NOT wired into `pnpm dev`; run manually, e.g.:
 *
 *   pnpm --filter @polyshield/signing-layer setup:deposit-wallet derive-address
 *   pnpm --filter @polyshield/signing-layer setup:deposit-wallet mint-creds
 *   pnpm --filter @polyshield/signing-layer setup:deposit-wallet deploy-wallet
 *   pnpm --filter @polyshield/signing-layer setup:deposit-wallet status
 *
 * Subcommands:
 *   derive-address  Print the CREATE2 deposit-wallet address for the operator EOA. Feed it as
 *                   DEPOSIT_WALLET (contract deploy) and DEPOSIT_WALLET_ADDRESS (signing layer).
 *   mint-creds      Mint/derive the L2 CLOB API creds (key/secret/passphrase) from the operator
 *                   EOA. SECRETS — printed to stdout only, never logged. Store them securely.
 *   deploy-wallet   Deploy the deposit wallet (WALLET-CREATE) via the relayer if not deployed.
 *   status          Print a readiness checklist (derived address, deployed?, pUSD allowances).
 *
 * Requires (per command): VAULT_EOA_PRIVATE_KEY, POLYGON_RPC_URL always; POLY_RELAYER_URL for
 * derive-address/deploy-wallet/status; POLY_API_URL (defaults to mainnet) for mint-creds.
 */
import { ethers } from "ethers";
import pino from "pino";
import { config } from "../config";
import {
  deriveDepositWalletAddress,
  getProductionRelayClient,
} from "../depositWalletExecutor";

const logger = pino({ name: "deposit-wallet-setup" });

const ERC20_ALLOWANCE_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
];

async function cmdDeriveAddress(): Promise<void> {
  const address = await deriveDepositWalletAddress();
  // Address is not a secret — plain stdout is fine and keeps it copy-pasteable.
  process.stdout.write(`\nDeposit wallet address: ${address}\n`);
  process.stdout.write(
    "→ set this as DEPOSIT_WALLET (contract deploy / Deploy.s.sol) AND DEPOSIT_WALLET_ADDRESS (signing layer).\n",
  );
}

async function cmdMintCreds(): Promise<void> {
  const host = process.env.POLY_API_URL ?? "https://clob.polymarket.com";
  const provider = new ethers.JsonRpcProvider(config.polygonRpcUrl);
  const wallet = new ethers.Wallet(config.vaultEoaPrivateKey, provider);

  const { ClobClient, Chain } = await import("@polymarket/clob-client-v2");
  const client = new ClobClient({
    host,
    chain: Chain.POLYGON,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signer: wallet as any,
  });

  const creds = await client.createOrDeriveApiKey();

  // SECRETS: write directly to stdout, never through pino (structured logs may be shipped).
  process.stdout.write("\n===== Polymarket L2 API credentials (STORE SECURELY — shown once) =====\n");
  process.stdout.write(`POLY_API_KEY=${creds.key}\n`);
  process.stdout.write(`POLY_SECRET=${creds.secret}\n`);
  process.stdout.write(`POLY_PASSPHRASE=${creds.passphrase}\n`);
  process.stdout.write("======================================================================\n");
  process.stdout.write("Copy these into your secrets manager and replace any mock-* values.\n");
}

async function cmdDeployWallet(): Promise<void> {
  if (!config.depositWalletAddress) {
    throw new Error("DEPOSIT_WALLET_ADDRESS not set — run derive-address and set it first");
  }
  const client = getProductionRelayClient();
  const deployed = await client.getDeployed(config.depositWalletAddress, "WALLET");
  if (deployed) {
    logger.info({ depositWallet: config.depositWalletAddress }, "deposit wallet already deployed — nothing to do");
    return;
  }
  logger.info({ depositWallet: config.depositWalletAddress }, "deploying deposit wallet (WALLET-CREATE)");
  const tx = await client.deployDepositWallet();
  const mined = await tx.wait();
  if (!mined) throw new Error(`deployDepositWallet failed/timed out (txId=${tx.transactionID}, state=${tx.state})`);
  logger.info({ txHash: mined.transactionHash }, "deposit wallet deployed");
}

async function cmdStatus(): Promise<void> {
  const derived = await deriveDepositWalletAddress();
  const configured = config.depositWalletAddress || "(unset)";
  const match = config.depositWalletAddress
    ? derived.toLowerCase() === config.depositWalletAddress.toLowerCase()
    : false;

  const client = getProductionRelayClient();
  const deployed = config.depositWalletAddress
    ? await client.getDeployed(config.depositWalletAddress, "WALLET")
    : false;

  // pUSD allowances from the deposit wallet to the CTF exchange + offramp (readiness for trading/settlement).
  const lines: string[] = [];
  if (config.pusdAddress && config.depositWalletAddress) {
    const provider = new ethers.JsonRpcProvider(config.polygonRpcUrl);
    const pusd = new ethers.Contract(config.pusdAddress, ERC20_ALLOWANCE_ABI, provider);
    for (const [name, spender] of [
      ["CTF exchange (V2)", config.ctfExchangeV2Address],
      ["offramp", config.offrampAddress],
    ] as const) {
      if (spender && spender !== ethers.ZeroAddress) {
        const allowance: bigint = await pusd.allowance(config.depositWalletAddress, spender);
        lines.push(`  pUSD allowance → ${name} (${spender}): ${allowance > 0n ? "set" : "MISSING"}`);
      }
    }
  } else {
    lines.push("  pUSD allowances: skipped (PUSD_ADDRESS / DEPOSIT_WALLET_ADDRESS unset)");
  }

  process.stdout.write("\n===== Deposit wallet readiness =====\n");
  process.stdout.write(`  derived address:    ${derived}\n`);
  process.stdout.write(`  configured address: ${configured}\n`);
  process.stdout.write(`  match:              ${match ? "OK" : "MISMATCH"}\n`);
  process.stdout.write(`  deployed (WALLET):  ${deployed ? "yes" : "NO"}\n`);
  process.stdout.write(`${lines.join("\n")}\n`);
  process.stdout.write("====================================\n");
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case "derive-address":
      await cmdDeriveAddress();
      break;
    case "mint-creds":
      await cmdMintCreds();
      break;
    case "deploy-wallet":
      await cmdDeployWallet();
      break;
    case "status":
      await cmdStatus();
      break;
    default:
      process.stdout.write(
        "Usage: setup:deposit-wallet <derive-address | mint-creds | deploy-wallet | status>\n",
      );
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  logger.error({ err }, "deposit-wallet setup command failed");
  process.exit(1);
});
