import "dotenv/config";

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    // Log key name only — never log the value
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const config = {
  vaultEoaPrivateKey: requireEnv("VAULT_EOA_PRIVATE_KEY"),
  polyApiKey: requireEnv("POLY_API_KEY"),
  polySecret: requireEnv("POLY_SECRET"),
  polyPassphrase: requireEnv("POLY_PASSPHRASE"),
  polygonRpcUrl: requireEnv("POLYGON_RPC_URL"),
  vaultContractAddress: requireEnv("VAULT_CONTRACT_ADDRESS"),
  signingLayerOperatorAddress: requireEnv("SIGNING_LAYER_OPERATOR_ADDRESS"),
} as const;
