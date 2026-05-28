'use client'
import { useEffect } from 'react'
import { useAccount } from 'wagmi'
import { WalletConnect } from '@/components/ui/WalletConnect'
import { Logo } from '@/components/ui/Logo'
import { clearNoteCache } from '@/lib/notes'
import { useChainResetDetector } from '@/lib/accountState'
import { initProver } from '@/lib/prover'

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { isConnected, status } = useAccount()
  const chainWasReset = useChainResetDetector()

  // Start fetching all circuit .wasm and .zkey files as soon as the user enters
  // the app, well before they reach any proof step.
  useEffect(() => {
    initProver()
  }, [])

  useEffect(() => {
    if (!isConnected) {
      clearNoteCache()
    }
  }, [isConnected])

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
          {chainWasReset ? (
            <>
              <h2 className="h3 mt-6" style={{ margin: 0 }}>Chain reset detected</h2>
              <p className="body mt-3" style={{ fontSize: 14 }}>
                The local dev chain was restarted. Your wallet was disconnected and all local note data was cleared. Reconnect and make a fresh deposit to continue.
              </p>
            </>
          ) : (
            <>
              <h2 className="h3 mt-6" style={{ margin: 0 }}>Connect your wallet</h2>
              <p className="body mt-3" style={{ fontSize: 14 }}>
                Connect a wallet to access the Polyshield app, deposit USDC, place private bets, and manage your account.
              </p>
            </>
          )}
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
      <main style={{ minWidth: 0, overflow: 'hidden' }}>
        {children}
      </main>
    </div>
  )
}
