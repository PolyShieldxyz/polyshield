/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack(config, { isServer }) {
    // Enable async WebAssembly — required for @noir-lang/acvm_js and @noir-lang/noirc_abi
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
      layers: true,
    }

    // Prevent server-side bundling of browser-only WASM/crypto packages
    if (isServer) {
      config.externals = config.externals || []
      config.externals.push('@aztec/bb.js')
    }

    return config
  },
}

module.exports = nextConfig
