'use client'
import { useEffect, useRef, useState } from 'react'
import { useAccount, useSwitchChain, useDisconnect } from 'wagmi'
import { WalletConnect } from '@/components/ui/WalletConnect'
import { BetaConsentGate } from '@/components/app/BetaConsentGate'
import { Logo } from '@/components/ui/Logo'
import { clearNoteCache, getFreeNotes, resetAllLocalState, resetWalletConnectorStorage } from '@/lib/notes'
import { clearSession } from '@/lib/secretSession'
import { useNotesHydration } from '@/lib/useNotesHydration'
import { useChainResetDetector } from '@/lib/accountState'
import { initProver, preloadConsolidateCircuit } from '@/lib/prover'

// A wallet with more than this many free (spendable) notes is fragmented enough that an upcoming
// bet/withdrawal will likely exceed any single note and need a note-merge first. Above the
// threshold we warm the large consolidate artifacts so that merge isn't a cold ~22 MB download.
const CONSOLIDATE_PRELOAD_NOTE_THRESHOLD = 5

// The chain the app expects (137 = Polygon in prod; 31337 = Anvil in dev). On any other
// network, on-chain reads (USDC balance, allowance) silently return nothing.
const EXPECTED_CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? '137')

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { address, isConnected, status, chainId } = useAccount()
  const { switchChain, isPending: switching } = useSwitchChain()
  const { disconnect } = useDisconnect()

  // Hard escape hatch for a wedged wallet session (broken reconnect after a hard refresh: the gate
  // persists, "Disconnect" reopens the connect modal). Force-disconnect, wipe the connector's
  // persisted state so a broken connector isn't restored, then reload to a clean slate.
  const resetConnection = () => {
    try { disconnect() } catch { /* no active connector — storage wipe below still recovers it */ }
    resetWalletConnectorStorage()
    window.location.reload()
  }
  const chainWasReset = useChainResetDetector()
  const notesReady = useNotesHydration()
  const prevConnected = useRef<boolean | null>(null)
  // Safety valve: if wagmi never leaves 'reconnecting'/'connecting' (broken connector / RPC), stop
  // waiting after a few seconds and show the connect gate rather than a blank page forever.
  const [reconnectTimedOut, setReconnectTimedOut] = useState(false)
  useEffect(() => {
    if (status === 'reconnecting' || status === 'connecting') {
      const t = setTimeout(() => setReconnectTimedOut(true), 6000)
      return () => clearTimeout(t)
    }
    setReconnectTimedOut(false) // settled → reset for any future reconnect
  }, [status])

  // Start fetching the entry-flow circuit .wasm and .zkey files as soon as the
  // user enters the app, well before they reach any proof step.
  useEffect(() => {
    initProver()
  }, [])

  // Once notes have hydrated, lazily warm the heavy consolidate artifacts for fragmented wallets
  // (many free notes ⇒ a spend will likely need a merge). Idempotent, so re-running on note
  // changes is cheap; it shifts the ~22 MB download off the withdrawal/bet critical path.
  useEffect(() => {
    if (!notesReady || !address) return
    if (getFreeNotes(address).length > CONSOLIDATE_PRELOAD_NOTE_THRESHOLD) {
      preloadConsolidateCircuit()
    }
  }, [notesReady, address])

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
      // FC-13: forget the in-memory master seed so the next connector can't reuse it.
      clearSession()
      // Clear persisted state too (encrypted IDB cache + localStorage counters) so a shared
      // device does not leak the prior user's notes/activity/deposit-index to the next connector.
      resetAllLocalState()
    }
    prevConnected.current = isConnected
  }, [isConnected])

  // During initial hydration wagmi status is 'reconnecting' while it restores
  // the previous session from storage. Rendering the gate during this window
  // causes it to flash on every page load even when already connected.
  // BUT a broken connector (e.g. an invalid WalletConnect project id, or a
  // CORS-blocked RPC) can leave wagmi stuck in 'reconnecting'/'connecting'
  // FOREVER — which used to render nothing but the outer nav (the "only the
  // nav bar loads" bug). Cap the wait so we always fall through to the connect
  // gate instead of hanging on a blank page.
  if ((status === 'reconnecting' || status === 'connecting') && !reconnectTimedOut) {
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
                Connect a wallet to access the PolyShield app, deposit USDC, place private bets, and manage your account.
              </p>
            </>
          )}
          <div className="mt-6" style={{ display: 'flex', justifyContent: 'center' }}>
            <WalletConnect />
          </div>
          {/* Escape hatch: if a previous session is wedged (gate keeps showing even though your wallet
              says it's connected, or Disconnect just reopens this modal), reset the connection state. */}
          <div className="small mt-3" style={{ fontSize: 11 }}>
            <button
              onClick={resetConnection}
              style={{ background: 'none', border: 'none', color: 'var(--text-3)', textDecoration: 'underline', cursor: 'pointer', fontSize: 11 }}
              title="Force-disconnect and clear the saved wallet session, then reload"
            >
              Stuck connecting? Reset connection
            </button>
          </div>
          <div className="small mt-4" style={{ fontSize: 11, color: 'var(--text-3)' }}>
            Polygon mainnet · beta
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
            PolyShield runs on {target}, but your wallet is on chain {chainId}. Your USDC
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

  // FC-13: hold note-reading screens until the encrypted cache has hydrated into memory, so the
  // first paint never reads an empty cache (which would flash a $0 balance / "no notes").
  if (!notesReady) return null

  // Beta terms gate: connected + correct network, but require a one-time signed acknowledgement
  // before any app content (deposit/bet/withdraw) is reachable.
  const shell = (
    <div className="app-shell">
      {/* FINDING: A11Y-003 — distinct id ("app-main") to avoid duplicating the
          root layout's #main skip-link target, which already wraps this subtree. */}
      <main id="app-main" style={{ minWidth: 0, overflow: 'hidden' }}>
        {children}
      </main>
    </div>
  )

  return address ? <BetaConsentGate address={address}>{shell}</BetaConsentGate> : shell
}
