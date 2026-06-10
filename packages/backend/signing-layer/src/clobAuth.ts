import pino from "pino";
import { getViemWallet } from "./builderConfig";
import { config } from "./config";

const logger = pino({ name: "clob-auth" });

export interface ClobCreds {
  key: string;
  secret: string;
  passphrase: string;
}

function isMockClob(): boolean {
  const host = process.env.POLY_API_URL ?? "https://clob.polymarket.com";
  return host.includes("localhost") || host.includes("127.0.0.1");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _creds: ClobCreds | null = null;

/**
 * The L2 CLOB API creds (key/secret/passphrase) DERIVED from the operator wallet's signature via
 * `createOrDeriveApiKey`. The static POLY_API_* env creds are rejected by the live CLOB ("Invalid
 * api key"), so BOTH order submission AND the user-channel websocket subscribe must use these
 * derived creds (previously the ws used the stale env creds → Polymarket closed the socket on
 * every connect → no fill/partial/expiry was ever detected). In mock/dev the env creds are
 * returned unchanged (the mock CLOB doesn't validate). Cached after first derivation.
 */
export async function getClobCreds(): Promise<ClobCreds> {
  if (_creds) return _creds;
  const envCreds: ClobCreds = {
    key: config.polyApiKey,
    secret: config.polySecret,
    passphrase: config.polyPassphrase,
  };
  if (isMockClob()) {
    _creds = envCreds;
    return _creds;
  }
  const clobHost = process.env.POLY_API_URL ?? "https://clob.polymarket.com";
  try {
    const { ClobClient, Chain } = await import("@polymarket/clob-client-v2");
    const bootstrap = new ClobClient({
      host: clobHost,
      chain: Chain.POLYGON,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signer: getViemWallet() as any,
    });
    _creds = (await bootstrap.createOrDeriveApiKey()) as ClobCreds;
    logger.info("CLOB L2 api creds derived (shared by order submission + ws fill tracker)");
  } catch (err) {
    logger.warn({ err: String(err) }, "createOrDeriveApiKey failed — falling back to env POLY_API_* creds");
    _creds = envCreds;
  }
  return _creds;
}
