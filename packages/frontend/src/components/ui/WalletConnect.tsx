'use client'
import { ConnectKitButton } from 'connectkit'

export function WalletConnect() {
  return (
    <ConnectKitButton.Custom>
      {({ isConnected, isConnecting, show, address }) => (
        <button className="btn btn-sm btn-primary" onClick={show}>
          {isConnected
            ? `${address?.slice(0, 6)}…${address?.slice(-4)}`
            : isConnecting
            ? 'Connecting…'
            : 'Connect Wallet'}
        </button>
      )}
    </ConnectKitButton.Custom>
  )
}
