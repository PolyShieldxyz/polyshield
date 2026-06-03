const path = require('path')

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin the workspace root to the monorepo root so Next stops inferring it from a
  // stray lockfile (it had picked ~/package-lock.json). Fixes the multiple-lockfiles
  // warning and keeps output file tracing scoped to this repo.
  outputFileTracingRoot: path.join(__dirname, '..', '..'),

  // FINDING: PERF-001 — circuit .wasm/.zkey artifacts are content-stable, so cache
  // them immutably for a year. Combined with lazy on-demand loading in prover.ts,
  // repeat visits and on-demand circuit fetches are served from cache instantly.
  async headers() {
    return [
      {
        source: '/:dir(circuits|zkeys)/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
    ]
  },

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
