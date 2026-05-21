'use client'
import { useEffect } from 'react'
import { useAccount } from 'wagmi'
import { AppSidebar } from '@/components/app/AppSidebar'
import { WalletConnect } from '@/components/ui/WalletConnect'
import { Logo } from '@/components/ui/Logo'
import { warmUpProver } from '@/lib/prover'

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { isConnected, status } = useAccount()

  // Kick off WASM download + backend init 2 s after the layout mounts.
  // This way the 63 MB bb.js bundle is cached by the time the user reaches
  // the bet/withdraw/settle proof step.
  useEffect(() => {
    const t = setTimeout(warmUpProver, 2000)
    return () => clearTimeout(t)
  }, [])

  // During initial hydration wagmi status is 'reconnecting' while it restores
  // the previous session from storage. Rendering the gate during this window
  // causes it to flash on every page load even when already connected.
  if (status === 'reconnecting' || status === 'connecting') {
    return null
  }

  if (!isConnected) {
    return (
      <div style={{ minHeight: 'calc(100vh - 56px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="panel" style={{ padding: 48, maxWidth: 440, width: '100%', textAlign: 'center' }}>
          <Logo size={40} withText={false} />
          <h2 className="h3 mt-6" style={{ margin: 0 }}>Connect your wallet</h2>
          <p className="body mt-3" style={{ fontSize: 14 }}>
            Connect a wallet to access the Polyshield app — deposit USDC, authorize private bets,
            and manage your proof activity.
          </p>
          <div className="mt-6" style={{ display: 'flex', justifyContent: 'center' }}>
            <WalletConnect />
          </div>
          <div className="small mt-4" style={{ fontSize: 11, color: 'var(--text-3)' }}>
            Polygon mainnet · Amoy testnet supported
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <AppSidebar />
      <main style={{ minWidth: 0, overflow: 'hidden' }}>
        {children}
      </main>
    </div>
  )
}
