'use client'
import { useEffect, useRef } from 'react'
import { useAccount, useSwitchChain } from 'wagmi'
import { WalletConnect } from '@/components/ui/WalletConnect'
import { Logo } from '@/components/ui/Logo'
import { clearNoteCache, resetAllLocalState } from '@/lib/notes'
import { useChainResetDetector } from '@/lib/accountState'
import { initProver } from '@/lib/prover'

// The chain the app expects (137 = Polygon in prod; 31337 = Anvil in dev). On any other
// network, on-chain reads (USDC balance, allowance) silently return nothing.
const EXPECTED_CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? '137')

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { isConnected, status, chainId } = useAccount()
  const { switchChain, isPending: switching } = useSwitchChain()
  const chainWasReset = useChainResetDetector()
  const prevConnected = useRef<boolean | null>(null)

  // Start fetching the entry-flow circuit .wasm and .zkey files as soon as the
  // user enters the app, well before they reach any proof step.
  useEffect(() => {
    initProver()
  }, [])

  useEffect(() => {
    // FINDING: PRIV-004 — only wipe persisted state on an actual connected→
    // disconnected transition, never on the initial render (when isConnected may
    // already be false during reconnect). Guarding with prevConnected mirrors the
    // pattern in WalletConnect.tsx and avoids clobbering a returning user's cache.
    if (prevConnected.current === null) {
      prevConnected.current = isConnected
      return
    }
    if (prevConnected.current && !isConnected) {
      clearNoteCache()
      // Clear localStorage too so a shared device does not leak the prior user's
      // notes/activity/deposit-index to the next connector.
      resetAllLocalState()
    }
    prevConnected.current = isConnected
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

  // Wrong-network gate: connected, but the wallet is on a chain the app can't read.
  if (isConnected && chainId !== undefined && chainId !== EXPECTED_CHAIN_ID) {
    const target = EXPECTED_CHAIN_ID === 137 ? 'Polygon' : `chain ${EXPECTED_CHAIN_ID}`
    return (
      <div style={{ minHeight: 'calc(100vh - 56px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="panel" style={{ padding: 48, maxWidth: 440, width: '100%', textAlign: 'center' }}>
          <Logo size={40} withText={false} />
          <h2 className="h3 mt-6" style={{ margin: 0 }}>Wrong network</h2>
          <p className="body mt-3" style={{ fontSize: 14 }}>
            Polyshield runs on {target}, but your wallet is on chain {chainId}. Your USDC
            balance and deposits won&apos;t load until you switch.
          </p>
          <div className="mt-6" style={{ display: 'flex', justifyContent: 'center' }}>
            <button
              className="btn btn-primary"
              onClick={() => switchChain({ chainId: EXPECTED_CHAIN_ID })}
              disabled={switching}
              style={{ padding: '12px 24px' }}
            >
              {switching ? 'Switching…' : `Switch to ${target}`}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="app-shell">
      {/* FINDING: A11Y-003 — distinct id ("app-main") to avoid duplicating the
          root layout's #main skip-link target, which already wraps this subtree. */}
      <main id="app-main" style={{ minWidth: 0, overflow: 'hidden' }}>
        {children}
      </main>
    </div>
  )
}
