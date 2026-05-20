import { config } from "./config.js";

// L2 HMAC credentials for Polymarket CLOB API.
// The API key, secret, and passphrase come from the environment only.
// They are never logged or sent to any service other than api.polymarket.com.
export function getL2Headers(): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  // The CLOB client signs the request; we just pass the credential fields.
  // The actual HMAC signing is handled by @polymarket/clob-client-v2.
  return {
    "POLY-API-KEY": config.polyApiKey,
    "POLY-SIGNATURE": "", // filled by clob-client signing
    "POLY-TIMESTAMP": timestamp,
    "POLY-PASSPHRASE": config.polyPassphrase,
  };
}
