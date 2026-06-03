'use client'
import { useEffect, useRef } from 'react'
import { ConnectKitButton } from 'connectkit'
import { useAccount } from 'wagmi'
import { log } from '@/lib/logger'
import { clearNoteCache, resetAllLocalState } from '@/lib/notes'

// Used in two places:
// 1. Gate panel (app/layout.tsx) — shows "Connect Wallet" when not connected
// 2. AppSidebar bottom — shows address when connected; clicking opens modal with disconnect option
export function WalletConnect({ variant = 'gate' }: { variant?: 'gate' | 'sidebar' }) {
  const { isConnected, address } = useAccount()
  const prevConnected = useRef<boolean | null>(null)
  const prevAddress = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (prevConnected.current === null) {
      prevConnected.current = isConnected
      prevAddress.current = address
      return
    }
    if (!prevConnected.current && isConnected && address) {
      log('wallet_connected', { address, ens: null })
    } else if (prevConnected.current && !isConnected) {
      log('wallet_disconnected', { prevAddress: prevAddress.current })
      // FINDING: PRIV-004 — on an actual connected→disconnected transition (guarded
      // by prevConnected so it never fires on first mount), wipe persisted note
      // state from localStorage, not just the in-memory cache. On a shared device,
      // leaving notes/activity/deposit-index in localStorage would expose the prior
      // user's pseudonymous trading history to the next connector.
      clearNoteCache()
      resetAllLocalState()
    } else if (isConnected && address && address !== prevAddress.current) {
      log('wallet_address_changed', { from: prevAddress.current, to: address })
    }
    prevConnected.current = isConnected
    prevAddress.current = address
  }, [isConnected, address])

  return (
    <ConnectKitButton.Custom>
      {({ isConnected: ckConnected, isConnecting, show, address: ckAddress, ensName }) => {
        const label = ensName ?? (ckAddress ? `${ckAddress.slice(0, 6)}…${ckAddress.slice(-4)}` : '')

        if (variant === 'sidebar') {
          return (
            <button
              onClick={() => { log('wallet_modal_open', { variant, isConnected: ckConnected, address: ckAddress ?? null }); show?.() }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 8,
                padding: '8px 10px',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <span
                className="dot"
                style={{
                  background: ckConnected ? 'var(--green)' : 'var(--text-3)',
                  boxShadow: ckConnected ? '0 0 6px var(--green)' : 'none',
                  flexShrink: 0,
                }}
              />
              <span style={{ fontSize: 12, color: 'var(--text-1)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {ckConnected ? label : isConnecting ? 'Connecting…' : 'Connect wallet'}
              </span>
              {ckConnected && (
                <span style={{ fontSize: 10, color: 'var(--text-3)', flexShrink: 0 }}>
                  ···
                </span>
              )}
            </button>
          )
        }

        // Gate variant — large centered button for the "not connected" wall
        return (
          <button className="btn btn-sm btn-primary" onClick={() => { log('wallet_modal_open', { variant, isConnected: ckConnected, address: ckAddress ?? null }); show?.() }}>
            {ckConnected ? label : isConnecting ? 'Connecting…' : 'Connect Wallet'}
          </button>
        )
      }}
    </ConnectKitButton.Custom>
  )
}
