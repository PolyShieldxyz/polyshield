import "dotenv/config";

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, fallback = ""): string {
  return process.env[key] ?? fallback;
}

export const config = {
  vaultEoaPrivateKey: requireEnv("VAULT_EOA_PRIVATE_KEY"),
  polyApiKey: requireEnv("POLY_API_KEY"),
  polySecret: requireEnv("POLY_SECRET"),
  polyPassphrase: requireEnv("POLY_PASSPHRASE"),
  // FC-4: authenticated user-channel websocket for resting GTC/GTD fill tracking. Dev
  // points this at the mock CLOB's /ws/user; production uses the Polymarket endpoint.
  polyWsUrl: optionalEnv("POLY_WS_URL", "wss://ws-subscriptions-clob.polymarket.com/ws/user"),
  polygonRpcUrl: requireEnv("POLYGON_RPC_URL"),
  vaultContractAddress: requireEnv("VAULT_CONTRACT_ADDRESS"),
  signingLayerOperatorAddress: requireEnv("SIGNING_LAYER_OPERATOR_ADDRESS"),
  ctfAddress: optionalEnv("CTF_ADDRESS", "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"),
  // CTF Exchange V2 — the operator approved (ERC-1155 setApprovalForAll) on the deposit
  // wallet so it can SELL / closePosition. Defaults to the live Polygon mainnet exchange.
  ctfExchangeV2Address: optionalEnv("CTF_EXCHANGE_V2_ADDRESS", "0xE111180000d2663C0091e4f400237545B87B996B"),
  usdcAddress: optionalEnv("USDC_ADDRESS"),
  pusdAddress: optionalEnv("PUSD_ADDRESS"),
  onrampAddress: optionalEnv("ONRAMP_ADDRESS"),
  offrampAddress: optionalEnv("OFFRAMP_ADDRESS"),
  // Post-April-2026 deposit wallet is an ERC-1967 proxy (mock: MockDepositWallet).
  depositWalletAddress: optionalEnv("DEPOSIT_WALLET_ADDRESS"),
  // Relayer for deposit-wallet WALLET batches. MOCK_RELAYER_URL → local mock relayer
  // (in the mock CLOB server); POLY_RELAYER_URL → production Polymarket builder relayer.
  mockRelayerUrl: optionalEnv("MOCK_RELAYER_URL"),
  polyRelayerUrl: optionalEnv("POLY_RELAYER_URL"),
  relayerPrivateKey: optionalEnv("RELAYER_PRIVATE_KEY"),
  // Private key for the deposit wallet EOA — used in local dev to sign pUSD approvals,
  // offramp calls, and USDC transfers that must originate from the deposit wallet.
  // In production these are submitted as Polymarket relayer WALLET batch transactions instead.
  depositWalletKey: optionalEnv("DEPOSIT_WALLET_KEY"),
  mockDeployerPrivateKey: optionalEnv("MOCK_DEPLOYER_PRIVATE_KEY"),
  // Polymarket Builder Program. `polyBuilderCode` is the on-chain order attribution
  // (clob-client-v2 `builderConfig.builderCode`); the builder creds authenticate the
  // builder-relayer-client's gas-free WALLET batches (builder-signing-sdk BuilderConfig).
  // All optional — unset => non-builder path (mock/dev unaffected).
  polyBuilderCode: optionalEnv("POLY_BUILDER_CODE"),
  polyBuilderKey: optionalEnv("POLY_BUILDER_KEY"),
  polyBuilderSecret: optionalEnv("POLY_BUILDER_SECRET"),
  polyBuilderPassphrase: optionalEnv("POLY_BUILDER_PASSPHRASE"),
  // Alternative to local builder creds: a remote builder signer (url + optional token).
  polyBuilderRemoteUrl: optionalEnv("POLY_BUILDER_REMOTE_URL"),
  polyBuilderRemoteToken: optionalEnv("POLY_BUILDER_REMOTE_TOKEN"),
  redemptionRelayTimeoutBlocks: parseInt(optionalEnv("REDEMPTION_RELAY_TIMEOUT_BLOCKS", "50"), 10),
  redemptionRelayMaxRetries: parseInt(optionalEnv("REDEMPTION_RELAY_MAX_RETRIES", "3"), 10),
  // FC-6 (Option 4) base-buffer manager. Proactively keep the deposit wallet pre-funded with pUSD
  // so most bets spend from an already-indexed buffer (no per-bet USDC→pUSD wrap → no Polymarket
  // indexing lag), leaving JIT only as the overflow path. All 1e6-scaled USDC. lowWater == 0
  // DISABLES the manager (safe default — ship the mechanism, enable by config later). Bounded
  // on-chain by the Vault's deploymentCap (SEC-007): fundPolymarketWallet reverts DeployCapExceeded
  // if a top-up would breach it, so keep target below the cap headroom.
  bufferLowWaterUsdc: BigInt(optionalEnv("BUFFER_LOW_WATER_USDC", "0") || "0"),
  bufferTargetUsdc: BigInt(optionalEnv("BUFFER_TARGET_USDC", "0") || "0"),
  bufferHighWaterUsdc: BigInt(optionalEnv("BUFFER_HIGH_WATER_USDC", "0") || "0"),
  bufferManagerPollMs: parseInt(optionalEnv("BUFFER_MANAGER_POLL_MS", "30000"), 10),
  // FALLBACK CLOB taker-fee reserve (bps of the market-BUY notional), used ONLY when the exact
  // per-market fee can't be fetched from the CLOB. The real Polymarket taker fee is VARIABLE —
  // price-dependent (∝ p·(1−p)) and per-market/category (per-token rate; some categories fee-free) —
  // and budgetedBuyOrder reserves it via the SDK's own formula + feeInfos. This flat value is the
  // degraded path only (fee endpoint unreachable). Conservative ~1% (covers the observed ~0.77%).
  clobBuyFeeBps: parseInt(optionalEnv("CLOB_BUY_FEE_BPS", "100"), 10),
} as const;
