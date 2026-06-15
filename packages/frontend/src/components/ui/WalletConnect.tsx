'use client'
import { useEffect, useRef } from 'react'
import { ConnectKitButton } from 'connectkit'
import { useAccount } from 'wagmi'
import { log } from '@/lib/logger'
import { clearNoteCache, resetAllLocalState } from '@/lib/notes'
import { clearSession } from '@/lib/secretSession'

// Used in the gate panel (app/layout.tsx): shows "Connect Wallet" when not connected, and the
// truncated address when connected (clicking opens the ConnectKit modal with a disconnect option).
export function WalletConnect() {
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
      clearSession() // FC-13: drop the in-memory master seed on disconnect
      resetAllLocalState()
    } else if (isConnected && address && address !== prevAddress.current) {
      log('wallet_address_changed', { from: prevAddress.current, to: address })
      // FC-13: drop the prior account's in-memory master seed on an account switch (the seed is
      // address-keyed so it's never reused cross-account, but don't let it linger in memory).
      clearSession()
    }
    prevConnected.current = isConnected
    prevAddress.current = address
  }, [isConnected, address])

  return (
    <ConnectKitButton.Custom>
      {({ isConnected: ckConnected, isConnecting, show, address: ckAddress, ensName }) => {
        const label = ensName ?? (ckAddress ? `${ckAddress.slice(0, 6)}…${ckAddress.slice(-4)}` : '')

        return (
          <button className="btn btn-sm btn-primary" onClick={() => { log('wallet_modal_open', { isConnected: ckConnected, address: ckAddress ?? null }); show?.() }}>
            {ckConnected ? label : isConnecting ? 'Connecting…' : 'Connect Wallet'}
          </button>
        )
      }}
    </ConnectKitButton.Custom>
  )
}
