import { keccak256, toBytes } from 'viem'

/** Matches MockDeploy.s.sol keccak256("market_resolved_yes") — use for local settlement tests. */
export const CONDITION_RESOLVED_YES = keccak256(toBytes('market_resolved_yes')) as `0x${string}`

export const CONDITION_FED_CUT = keccak256(toBytes('fed-cut-dec')) as `0x${string}`
export const CONDITION_TRUMP_PARDON = keccak256(toBytes('trump-pardon')) as `0x${string}`
export const CONDITION_BTC_150K = keccak256(toBytes('btc-150k')) as `0x${string}`
