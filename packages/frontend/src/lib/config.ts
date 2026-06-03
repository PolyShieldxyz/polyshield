/**
 * FINDING: FUNC-004 — fail-fast environment validation.
 *
 * Several modules (src/lib/api.ts, src/lib/notes.ts, deposit/market pages) read
 * NEXT_PUBLIC_* config and silently fall back to the zero address or localhost
 * when a value is missing. In a real (non-dev) deployment that produces a UI that
 * appears to work but points at address(0) — deposits/approvals would be sent to
 * a dead contract. This module surfaces the misconfiguration loudly at startup.
 *
 * Dev mode (NEXT_PUBLIC_DEV_MODE === 'true') stays permissive: localhost RPC and
 * the dev contract addresses are expected, so validation is skipped.
 *
 * Env names mirror those read in src/lib/api.ts and src/lib/wagmi.ts.
 */

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

const IS_DEV = process.env.NEXT_PUBLIC_DEV_MODE === 'true'

// Required public config for a production build. CHAIN_RPC is the RPC the app
// reads from directly (see api.ts); POLYGON_RPC feeds wagmi's transport.
const REQUIRED_ADDRESS_VARS = ['NEXT_PUBLIC_VAULT_ADDRESS', 'NEXT_PUBLIC_USDC_ADDRESS'] as const
const REQUIRED_VARS = ['NEXT_PUBLIC_CHAIN_RPC', 'NEXT_PUBLIC_CHAIN_ID'] as const

const ENV: Record<string, string | undefined> = {
  NEXT_PUBLIC_VAULT_ADDRESS: process.env.NEXT_PUBLIC_VAULT_ADDRESS,
  NEXT_PUBLIC_USDC_ADDRESS: process.env.NEXT_PUBLIC_USDC_ADDRESS,
  NEXT_PUBLIC_CHAIN_RPC: process.env.NEXT_PUBLIC_CHAIN_RPC,
  NEXT_PUBLIC_CHAIN_ID: process.env.NEXT_PUBLIC_CHAIN_ID,
}

/**
 * Returns a list of human-readable problems with the current environment.
 * Empty array means the environment is valid (or dev mode is on).
 */
export function getEnvProblems(): string[] {
  if (IS_DEV) return []

  const problems: string[] = []

  for (const name of REQUIRED_VARS) {
    const v = ENV[name]
    if (!v || v.trim() === '') problems.push(`${name} is unset`)
  }

  for (const name of REQUIRED_ADDRESS_VARS) {
    const v = ENV[name]
    if (!v || v.trim() === '') {
      problems.push(`${name} is unset`)
    } else if (v.toLowerCase() === ZERO_ADDRESS) {
      problems.push(`${name} is the zero address (${ZERO_ADDRESS})`)
    }
  }

  return problems
}

/**
 * Validate required NEXT_PUBLIC_* config. In a non-dev build, throws if anything
 * is missing or set to the zero address. Safe to call on both server and client;
 * dev mode is a no-op.
 */
export function validateEnv(): void {
  const problems = getEnvProblems()
  if (problems.length === 0) return

  const message =
    `[polyshield] Invalid environment configuration:\n` +
    problems.map((p) => `  • ${p}`).join('\n') +
    `\nSet these NEXT_PUBLIC_* variables before building for production, ` +
    `or run in dev mode (NEXT_PUBLIC_DEV_MODE=true).`

  console.error(message)
  throw new Error(message)
}
