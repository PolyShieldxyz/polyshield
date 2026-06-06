const path = require('path')

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin the workspace root to the monorepo root so Next stops inferring it from a
  // stray lockfile (it had picked ~/package-lock.json). Fixes the multiple-lockfiles
  // warning and keeps output file tracing scoped to this repo.
  outputFileTracingRoot: path.join(__dirname, '..', '..'),

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
    return [
      {
        source: '/:dir(circuits|zkeys)/:path*',
        headers: [{ key: 'Cache-Control', value }],
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

module.exports = nextConfig
