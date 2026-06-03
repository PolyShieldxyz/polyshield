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
  redemptionRelayTimeoutBlocks: parseInt(optionalEnv("REDEMPTION_RELAY_TIMEOUT_BLOCKS", "50"), 10),
  redemptionRelayMaxRetries: parseInt(optionalEnv("REDEMPTION_RELAY_MAX_RETRIES", "3"), 10),
} as const;
