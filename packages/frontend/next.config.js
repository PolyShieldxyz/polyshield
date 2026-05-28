/** @type {import('next').NextConfig} */
const nextConfig = {
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

    // Prevent SSR bundling of snarkjs (it's browser-only at runtime)
    if (isServer) {
      config.externals = config.externals || []
      config.externals.push('snarkjs')
    }

    return config
  },
}

module.exports = nextConfig
