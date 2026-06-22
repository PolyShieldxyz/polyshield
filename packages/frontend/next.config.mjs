import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin the workspace root to the monorepo root so Next stops inferring it from a
  // stray lockfile (it had picked ~/package-lock.json). Fixes the multiple-lockfiles
  // warning and keeps output file tracing scoped to this repo.
  outputFileTracingRoot: path.join(__dirname, '..', '..'),

  // The repo previously shipped no ESLint config, so `next build` printed "No ESLint configuration
  // detected" and skipped linting entirely. A config now exists ONLY to enforce the PERF-001/004
  // guard (.eslintrc.json: no main-thread proof generators outside the prover module). Keep lint OUT
  // of the build so adding that config doesn't suddenly gate `next build` on the full next ruleset
  // across pre-existing code — the guard runs via `pnpm lint` (next lint) instead. Same build
  // behavior as before; strictly more linting available on demand.
  eslint: { ignoreDuringBuilds: true },

  // FINDING: PERF-001 — circuit .wasm/.zkey artifacts are content-stable in production
  // (a release ships one fixed set), so cache them immutably for a year. Combined with
  // lazy on-demand loading in prover.ts, repeat visits and on-demand fetches are instant.
  //
  // In DEVELOPMENT the filenames are reused across recompiles (`pnpm setup:circuits`
  // overwrites e.g. bet_auth.wasm in place), so `immutable` made the browser keep serving
  // a STALE circuit after the circuit changed — proofs then fail against the freshly
  // regenerated zkey/verifier (and assertion line numbers no longer match the source).
  // Revalidate every dev request so a recompiled circuit is picked up on the next load.
  async headers() {
    const isDev = process.env.NODE_ENV !== 'production'
    const value = isDev
      ? 'no-cache, must-revalidate'
      : 'public, max-age=31536000, immutable'

    // FE-01: global security response headers. A wallet-signing privacy dApp must defend
    // against clickjacking (an iframe overlay tricking a user into approving a tx) and against
    // a script exfiltrating the de-anonymizing IndexedDB note cache. These headers are the
    // baseline; the CSP is the strongest lever.
    //
    // CSP notes:
    //  - script-src includes 'wasm-unsafe-eval' because snarkjs instantiates WASM in the
    //    proof worker; without it every bet/withdraw/settle/consolidate proof fails.
    //  - 'unsafe-inline' in script-src is retained for Next's hydration bootstrap; external
    //    <script src> is still blocked (script-src 'self'). Tightening to a per-request nonce
    //    is a follow-up; frame-ancestors/object-src/base-uri are the breakage-free wins now.
    //  - connect-src allows https:/wss: so WalletConnect relays and the configurable RPC keep
    //    working; extend/restrict via CSP_CONNECT_SRC. It still blocks plaintext (http:) exfil.
    //  - the CSP is applied in production only — Next dev (HMR) needs 'unsafe-eval' + ws to
    //    localhost, so we skip the CSP in dev but keep the other headers.
    const connectSrc = process.env.CSP_CONNECT_SRC ?? "'self' https: wss:"
    // frame-src: ConnectKit (Family) and WalletConnect render their connect/verify flows in
    // iframes. With no frame-src, CSP falls back to default-src 'self' and BLOCKS them —
    // which silently breaks wallet connection on mobile, where there is no injected
    // extension wallet and WalletConnect is the only path. Desktop hid the bug because an
    // injected MetaMask never frames these origins. Allow the known wallet-infra frame hosts.
    //  - app.family.co            ConnectKit's hosted connector UI
    //  - *.walletconnect.org/.com verify.walletconnect.org + WC explorer/relay UIs
    //  - keys.coinbase.com        Coinbase Smart Wallet popup/iframe
    const frameSrc = process.env.CSP_FRAME_SRC ??
      "'self' https://app.family.co https://verify.walletconnect.org https://verify.walletconnect.com " +
      "https://*.walletconnect.org https://*.walletconnect.com https://keys.coinbase.com"
    const csp = [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      `frame-src ${frameSrc}`,
      "form-action 'self'",
      "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      `connect-src ${connectSrc}`,
      "worker-src 'self' blob:",
    ].join('; ')

    const securityHeaders = [
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
      { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
      ...(isDev
        ? []
        : [
            { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
            { key: 'Content-Security-Policy', value: csp },
          ]),
    ]

    return [
      {
        source: '/:dir(circuits|zkeys)/:path*',
        headers: [{ key: 'Cache-Control', value }],
      },
      {
        // Apply security headers to every route.
        source: '/:path*',
        headers: securityHeaders,
      },
    ]
  },

  // NOTE: Turbopack (`next dev --turbopack`) was evaluated and is NOT usable here:
  // it deadlocks compiling the prover module Web Worker
  // (new Worker(new URL('../workers/prover.worker', import.meta.url), { type: 'module' }))
  // on Next 15.5.18 — confirmed on both Node 22 and Node 26 (compile stalls at 0.2% CPU,
  // no error). Every bet/withdraw/settle/consolidate proof runs through that worker, so
  // Turbopack would hang the dev server on the first proof route. Stay on webpack until a
  // newer Next/Turbopack resolves module-worker support. Do not add a `turbopack:` block.

  webpack(config, { isServer }) {
    // snarkjs uses some Node.js built-ins — provide browser stubs for client bundles
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        os: false,
        crypto: false,
      }
    }

    // Silence benign "module not found" warnings for optional peer deps that the
    // wallet stack references but never loads in a web build:
    //  - @react-native-async-storage/async-storage (via @metamask/sdk, RN-only)
    //  - pino-pretty (via @walletconnect logger, dev-only pretty printer)
    config.resolve.alias = {
      ...config.resolve.alias,
      '@react-native-async-storage/async-storage': false,
      'pino-pretty': false,
    }

    // Prevent SSR bundling of snarkjs (it's browser-only at runtime)
    if (isServer) {
      config.externals = config.externals || []
      config.externals.push('snarkjs')
    }

    return config
  },
}

export default nextConfig
