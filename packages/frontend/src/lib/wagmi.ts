import { polygon, polygonAmoy, mainnet } from 'wagmi/chains'
import { http, createConfig, type Transport } from 'wagmi'
import { defineChain } from 'viem'
import { getDefaultConfig } from 'connectkit'
import { polygonReadRpc } from './rpc'

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

// Ethereum mainnet is included ONLY so ConnectKit's ENS resolution (and a wallet that happens to be
// on chain 1) has a working, CORS-enabled transport. Without an explicit transport viem falls back
// to the chain's default public RPC (https://eth.merkle.io), which sends no CORS headers — every
// call fails in the browser and stalls the connect/ENS path (the "Failed to fetch eth.merkle.io"
// console storm). Override with NEXT_PUBLIC_MAINNET_RPC; cloudflare-eth.com is a CORS-friendly default.
const MAINNET_RPC = process.env.NEXT_PUBLIC_MAINNET_RPC || 'https://cloudflare-eth.com'

const chains = IS_DEV
  ? ([anvilChain, polygon, polygonAmoy, mainnet] as const)
  : ([polygon, polygonAmoy, mainnet] as const)

const transports: Record<number, Transport> = IS_DEV
  ? {
      [anvilChain.id]: http(DEV_RPC),
      [polygon.id]: http(polygonReadRpc()),
      [polygonAmoy.id]: http(),
      [mainnet.id]: http(MAINNET_RPC),
    }
  : {
      [polygon.id]: http(polygonReadRpc()),
      [polygonAmoy.id]: http(),
      [mainnet.id]: http(MAINNET_RPC),
    }

// A real WalletConnect project id is 32 hex chars. Reject placeholders like "???" (or empty) so
// ConnectKit doesn't spin up a doomed WC socket ("Unauthorized: invalid key") — that broken socket
// wedges reconnect on a hard refresh (gate persists, Disconnect reopens the connect modal). With an
// empty id, WalletConnect is simply unavailable and injected wallets work cleanly.
const RAW_WC = (process.env.NEXT_PUBLIC_WC_PROJECT_ID ?? '').trim()
const WC_PROJECT_ID = /^[0-9a-fA-F]{32}$/.test(RAW_WC) ? RAW_WC : ''
if (!WC_PROJECT_ID && typeof window !== 'undefined') {
  console.warn(
    '[polyshield] NEXT_PUBLIC_WC_PROJECT_ID is missing/invalid — WalletConnect disabled (injected ' +
      'wallets still work). Set a real 32-hex-char id from cloud.reown.com to enable WalletConnect.',
  )
}

export const wagmiConfig = createConfig(
  getDefaultConfig({
    chains,
    transports,
    walletConnectProjectId: WC_PROJECT_ID,
    appName: 'PolyShield',
    appDescription: 'Private prediction market trading.',
    appUrl: 'https://polyshield.xyz',
  })
)

export { anvilChain }
