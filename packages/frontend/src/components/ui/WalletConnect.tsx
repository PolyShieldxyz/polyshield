'use client'
import { ConnectKitButton } from 'connectkit'

// Used in two places:
// 1. Gate panel (app/layout.tsx) — shows "Connect Wallet" when not connected
// 2. AppSidebar bottom — shows address when connected; clicking opens modal with disconnect option
export function WalletConnect({ variant = 'gate' }: { variant?: 'gate' | 'sidebar' }) {
  return (
    <ConnectKitButton.Custom>
      {({ isConnected, isConnecting, show, address, ensName }) => {
        const label = ensName ?? (address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '')

        if (variant === 'sidebar') {
          return (
            <button
              onClick={show}
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
                  background: isConnected ? 'var(--green)' : 'var(--text-3)',
                  boxShadow: isConnected ? '0 0 6px var(--green)' : 'none',
                  flexShrink: 0,
                }}
              />
              <span style={{ fontSize: 12, color: 'var(--text-1)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {isConnected ? label : isConnecting ? 'Connecting…' : 'Connect wallet'}
              </span>
              {isConnected && (
                <span style={{ fontSize: 10, color: 'var(--text-3)', flexShrink: 0 }}>
                  ···
                </span>
              )}
            </button>
          )
        }

        // Gate variant — large centered button for the "not connected" wall
        return (
          <button className="btn btn-sm btn-primary" onClick={show}>
            {isConnected ? label : isConnecting ? 'Connecting…' : 'Connect Wallet'}
          </button>
        )
      }}
    </ConnectKitButton.Custom>
  )
}
