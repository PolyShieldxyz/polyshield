import { createWalletClient, http, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import pino from "pino";
import { config } from "./config";

const logger = pino({ name: "builder-config" });

/**
 * Polygon mainnet — the production target for every deposit-wallet relayer action and
 * POLY_1271 order. (Amoy testnet verification would swap this for `polygonAmoy` and the
 * chainId below.) Exported so the relayer executor passes a consistent chainId.
 */
export const POLYGON_CHAIN_ID = 137;

/** 0x-normalize a hex private key for viem's privateKeyToAccount (ethers tolerates unprefixed). */
function normalizePk(pk: string): `0x${string}` {
  return (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`;
}

let _viemWallet: WalletClient | null = null;

/**
 * The operator EOA as a viem WalletClient — the deposit wallet's owner/signer.
 *
 * Decision: the single vault signing key (VAULT_EOA_PRIVATE_KEY) owns the deposit wallet,
 * so it both signs POLY_1271 CLOB orders (via the ethers wallet in orderBuilder) AND signs
 * the relayer WALLET batches (via THIS viem wallet). The key is loaded locally with
 * privateKeyToAccount; it never leaves the process. Cached so we build one client.
 */
export function getViemWallet(): WalletClient {
  if (_viemWallet) return _viemWallet;
  const account = privateKeyToAccount(normalizePk(config.vaultEoaPrivateKey));
  _viemWallet = createWalletClient({
    account,
    chain: polygon,
    transport: http(config.polygonRpcUrl),
  });
  return _viemWallet;
}

let _relayerBuilderConfig: BuilderConfig | null | undefined;

/**
 * BuilderConfig for the builder-relayer-client — authenticates the operator as a registered
 * builder so deposit-wallet WALLET batches are gas-free. Built from local builder creds, or
 * a remote builder signer URL. Returns undefined when no builder creds are configured (the
 * relayer still works without builder auth; mock/dev is unaffected). Cached after first build.
 *
 * NOTE: this is the builder-signing-sdk `BuilderConfig` CLASS (auth creds) — distinct from
 * the clob-client's `builderConfig: { builderCode }` (order attribution); see getClobBuilderConfig.
 */
export function getRelayerBuilderConfig(): BuilderConfig | undefined {
  if (_relayerBuilderConfig !== undefined) return _relayerBuilderConfig ?? undefined;
  try {
    if (config.polyBuilderKey && config.polyBuilderSecret && config.polyBuilderPassphrase) {
      _relayerBuilderConfig = new BuilderConfig({
        localBuilderCreds: {
          key: config.polyBuilderKey,
          secret: config.polyBuilderSecret,
          passphrase: config.polyBuilderPassphrase,
        },
      });
      logger.info("relayer builder auth configured (local builder creds)");
    } else if (config.polyBuilderRemoteUrl) {
      _relayerBuilderConfig = new BuilderConfig({
        remoteBuilderConfig: {
          url: config.polyBuilderRemoteUrl,
          token: config.polyBuilderRemoteToken || undefined,
        },
      });
      logger.info({ url: config.polyBuilderRemoteUrl }, "relayer builder auth configured (remote signer)");
    } else {
      _relayerBuilderConfig = null; // memoize "none"
      // The Polymarket builder relayer REJECTS unauthenticated WALLET batches with 401
      // "invalid authorization" — without builder creds the deposit-wallet approvals AND the
      // JIT USDC→pUSD wrap fail, so trading needs a manual platform confirm. Surface loudly.
      logger.error(
        "NO relayer builder auth — set POLY_BUILDER_KEY + POLY_BUILDER_SECRET + POLY_BUILDER_PASSPHRASE " +
          "(all three) or POLY_BUILDER_REMOTE_URL. Deposit-wallet relayer batches will 401 until configured.",
      );
    }
  } catch (err) {
    // Invalid creds/url throw in the BuilderConfig ctor — surface loudly, don't crash.
    logger.error({ err }, "getRelayerBuilderConfig: invalid builder config — proceeding without builder auth");
    _relayerBuilderConfig = null;
  }
  return _relayerBuilderConfig ?? undefined;
}

/**
 * builderConfig for clob-client-v2 — attaches the on-chain builder code to orders
 * (`order.builder`). Returns undefined when POLY_BUILDER_CODE is unset so the SDK uses the
 * default (non-builder) path; never returns an empty/zero builderCode (which the SDK rejects).
 */
export function getClobBuilderConfig(): { builderCode: string } | undefined {
  return config.polyBuilderCode ? { builderCode: config.polyBuilderCode } : undefined;
}
