import { polygon, polygonAmoy } from 'wagmi/chains'
import { http, createConfig, type Transport } from 'wagmi'
import { defineChain } from 'viem'
import { getDefaultConfig } from 'connectkit'

const IS_DEV = process.env.NEXT_PUBLIC_DEV_MODE === 'true'
const DEV_RPC = process.env.NEXT_PUBLIC_CHAIN_RPC || 'http://127.0.0.1:8545'

// Local Anvil chain for dev — identical to Foundry's defaults
const anvilChain = defineChain({
  id: 31337,
  name: 'Anvil Local',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [DEV_RPC] },
  },
})

const chains = IS_DEV
  ? ([anvilChain, polygon, polygonAmoy] as const)
  : ([polygon, polygonAmoy] as const)

const transports: Record<number, Transport> = IS_DEV
  ? {
      [anvilChain.id]: http(DEV_RPC),
      [polygon.id]: http(process.env.NEXT_PUBLIC_POLYGON_RPC || undefined),
      [polygonAmoy.id]: http(),
    }
  : {
      [polygon.id]: http(process.env.NEXT_PUBLIC_POLYGON_RPC || undefined),
      [polygonAmoy.id]: http(),
    }

export const wagmiConfig = createConfig(
  getDefaultConfig({
    chains,
    transports,
    walletConnectProjectId: process.env.NEXT_PUBLIC_WC_PROJECT_ID ?? '',
    appName: 'Polyshield',
    appDescription: 'Private prediction market trading.',
    appUrl: 'https://polyshield.xyz',
  })
)

export { anvilChain }
