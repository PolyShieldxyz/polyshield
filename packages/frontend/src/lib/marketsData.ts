import {
  CONDITION_BTC_150K,
  CONDITION_FED_CUT,
  CONDITION_RESOLVED_YES,
  CONDITION_TRUMP_PARDON,
} from '@/lib/devMarkets'
import { keccak256, toBytes } from 'viem'

export type MarketEntry = {
  id: string
  conditionId: `0x${string}`
  cat: string
  name: string
  yes: number
  delta: number
  vol: number
  liq: number
  traders: number
  resolves: string
  endTs?: number // endDate as epoch ms (live markets); used for "Resolves soon" sort
  trend: number[]
  desc?: string
  sources?: string[]
  // Live Polymarket fields (populated by lib/polymarket.ts; absent for fixtures).
  yesTokenId?: string
  noTokenId?: string
  outcomeLabels?: [string, string] // real outcome names (e.g. ["Up","Down"]); YES=side 0
  acceptingOrders?: boolean
  source?: 'live' | 'fixture'
}

const cid = (label: string) => keccak256(toBytes(label)) as `0x${string}`

export const MARKETS: MarketEntry[] = [
  { id: 'fed-cut-dec', conditionId: CONDITION_FED_CUT, cat: 'MACRO', name: 'Fed cuts rates in December meeting?', yes: 0.71, delta: 0.046, vol: 24.7e6, liq: 4.2e6, traders: 4210, resolves: 'Dec 17, 2026', trend: [0.55,0.58,0.60,0.62,0.64,0.66,0.68,0.69,0.70,0.70,0.71], desc: 'Will the FOMC cut the federal funds target rate by at least 25bps at the December 17, 2026 meeting?', sources: ['FOMC press release', 'CME FedWatch'] },
  { id: 'trump-pardon', conditionId: CONDITION_TRUMP_PARDON, cat: 'POLITICS', name: 'Will Trump pardon all Jan 6 defendants by EOY 2026?', yes: 0.62, delta: 0.021, vol: 12.4e6, liq: 2.1e6, traders: 2810, resolves: 'Dec 31, 2026', trend: [0.40,0.45,0.50,0.53,0.55,0.57,0.59,0.60,0.61,0.61,0.62] },
  { id: 'btc-150k', conditionId: CONDITION_BTC_150K, cat: 'CRYPTO', name: 'BTC closes above $150k on Dec 31, 2026?', yes: 0.41, delta: 0.008, vol: 38.2e6, liq: 6.4e6, traders: 5102, resolves: 'Dec 31, 2026', trend: [0.32,0.34,0.36,0.38,0.39,0.40,0.40,0.41,0.41,0.41,0.41] },
  { id: 'openai-ipo', conditionId: cid('openai-ipo'), cat: 'TECH', name: 'OpenAI IPO files S-1 before Q4 2026?', yes: 0.28, delta: -0.012, vol: 8.9e6, liq: 1.2e6, traders: 1612, resolves: 'Sep 30, 2026', trend: [0.40,0.38,0.36,0.34,0.32,0.31,0.30,0.29,0.29,0.28,0.28] },
  { id: 'ethbtc-05', conditionId: cid('ethbtc-05'), cat: 'CRYPTO', name: 'ETH/BTC ratio above 0.05 by Q3 close?', yes: 0.18, delta: -0.003, vol: 4.1e6, liq: 0.6e6, traders: 941, resolves: 'Sep 30, 2026', trend: [0.27,0.25,0.23,0.22,0.21,0.20,0.19,0.19,0.18,0.18,0.18] },
  { id: 'russia-ukraine', conditionId: cid('russia-ukraine'), cat: 'GEO', name: 'Russia–Ukraine ceasefire signed in 2026?', yes: 0.33, delta: 0.015, vol: 11.0e6, liq: 1.8e6, traders: 2104, resolves: 'Dec 31, 2026', trend: [0.20,0.24,0.27,0.29,0.30,0.31,0.32,0.32,0.33,0.33,0.33] },
  { id: 'us-recession', conditionId: cid('us-recession'), cat: 'MACRO', name: 'NBER declares US recession in 2026?', yes: 0.22, delta: -0.008, vol: 9.4e6, liq: 1.4e6, traders: 1820, resolves: 'Dec 31, 2026', trend: [0.30,0.28,0.27,0.26,0.25,0.24,0.24,0.23,0.22,0.22,0.22] },
  { id: 'sb60-49ers', conditionId: cid('sb60-49ers'), cat: 'SPORTS', name: '49ers win Super Bowl LX?', yes: 0.14, delta: 0.004, vol: 6.2e6, liq: 0.9e6, traders: 1480, resolves: 'Feb 8, 2026', trend: [0.10,0.11,0.12,0.12,0.13,0.13,0.13,0.14,0.14,0.14,0.14] },
  { id: 'agi-2026', conditionId: cid('agi-2026'), cat: 'TECH', name: 'Any frontier lab declares AGI in 2026?', yes: 0.09, delta: 0.001, vol: 7.7e6, liq: 0.7e6, traders: 1330, resolves: 'Dec 31, 2026', trend: [0.05,0.06,0.07,0.08,0.08,0.08,0.09,0.09,0.09,0.09,0.09] },
  { id: 'eth-eip', conditionId: cid('eth-eip'), cat: 'CRYPTO', name: 'Ethereum hard fork ships by Sep 2026?', yes: 0.58, delta: 0.012, vol: 3.4e6, liq: 0.5e6, traders: 880, resolves: 'Sep 30, 2026', trend: [0.50,0.52,0.53,0.54,0.55,0.56,0.57,0.57,0.58,0.58,0.58] },
  { id: 'china-tw', conditionId: cid('china-tw'), cat: 'GEO', name: 'China military exercises around Taiwan in 2026?', yes: 0.84, delta: 0.022, vol: 5.6e6, liq: 0.8e6, traders: 1142, resolves: 'Dec 31, 2026', trend: [0.75,0.77,0.79,0.80,0.81,0.82,0.83,0.83,0.84,0.84,0.84] },
  { id: 'nobel-physics', conditionId: cid('nobel-physics'), cat: 'CULTURE', name: 'Nobel Physics 2026 awarded to quantum-computing researcher?', yes: 0.31, delta: 0.006, vol: 1.2e6, liq: 0.2e6, traders: 412, resolves: 'Oct 6, 2026', trend: [0.25,0.26,0.27,0.28,0.28,0.29,0.30,0.30,0.30,0.31,0.31] },
]

/** Pre-resolved mock market for local settlement E2E (MockDeploy RESOLVED_YES_MARKET). */
export const DEV_RESOLVED_MARKET_CONDITION = CONDITION_RESOLVED_YES
