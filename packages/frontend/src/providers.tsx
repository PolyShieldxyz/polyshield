'use client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WagmiProvider } from 'wagmi'
import { ConnectKitProvider } from 'connectkit'
import { wagmiConfig } from '@/lib/wagmi'
import { ReactNode, useEffect, useState } from 'react'
import { getEnvProblems } from '@/lib/config'

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient())

  // FINDING: FUNC-004 — surface missing/zero-address NEXT_PUBLIC_* config loudly at
  // runtime (browser startup). Client-only so it never throws during `next build`
  // prerendering (which would wrongly fail unrelated static pages like /docs). No-op
  // in dev mode (getEnvProblems returns [] when NEXT_PUBLIC_DEV_MODE=true).
  useEffect(() => {
    const problems = getEnvProblems()
    if (problems.length > 0) {
      console.error(
        '[polyshield] Invalid environment configuration:\n' +
          problems.map((p) => `  • ${p}`).join('\n') +
          '\nSet these NEXT_PUBLIC_* variables, or run in dev mode (NEXT_PUBLIC_DEV_MODE=true). ' +
          'Chain interactions will not work until this is fixed.',
      )
    }
  }, [])

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ConnectKitProvider theme="auto" mode="dark">
          {children}
        </ConnectKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
