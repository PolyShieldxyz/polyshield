/**
 * Browser-safe read endpoint for Polygon mainnet.
 *
 * In production we do NOT ship a keyed upstream RPC in the client bundle. Browser reads go through the
 * same-origin /api/rpc proxy (see app/api/rpc/route.ts), which forwards to the SERVER-ONLY
 * POLYGON_RPC_URL. This keeps the metered key private and lets us attribute/cap frontend traffic
 * separately from the backend (#4 + #6).
 *
 * In dev we keep the previous behaviour (talk to the configured public RPC directly) — key exposure is
 * a non-issue locally, and the proxy's server env may not be set in `pnpm dev:frontend`.
 */
const IS_DEV = process.env.NEXT_PUBLIC_DEV_MODE === 'true'

/** Polygon-mainnet read RPC for a browser-side viem/wagmi client. `undefined` => viem chain default. */
export function polygonReadRpc(): string | undefined {
  if (IS_DEV) return process.env.NEXT_PUBLIC_POLYGON_RPC || undefined
  return '/api/rpc'
}
