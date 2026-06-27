'use client'
import { useEffect, useRef } from 'react'
import { ConnectKitButton } from 'connectkit'
import { useAccount } from 'wagmi'
import { log } from '@/lib/logger'
import { clearNoteCache, resetAllLocalState } from '@/lib/notes'
import { clearSession } from '@/lib/secretSession'
import { isMoneyOpInFlight } from '@/lib/inFlightGuard'

// How long to wait after a connected→disconnected transition before treating it as a REAL
// disconnect and running the destructive wipe. Mobile / WalletConnect sessions drop and reconnect
// routinely; wiping immediately on every flap destroys the encrypted note cache + deposit-index
// counter (losing the index risks re-deriving a spent nullifier → locked funds — H7). If the wallet
// reconnects within this window, we cancel the wipe. The cache is encrypted with a non-extractable
// key, so brief retention across a flap is acceptable; the privacy intent (shared-device hygiene on a
// deliberate disconnect) is preserved — a real disconnect still wipes, just after a short delay.
const DISCONNECT_WIPE_DELAY_MS = 8_000

// Used in the gate panel (app/layout.tsx): shows "Connect Wallet" when not connected, and the
// truncated address when connected (clicking opens the ConnectKit modal with a disconnect option).
export function WalletConnect() {
  const { isConnected, address } = useAccount()
  const prevConnected = useRef<boolean | null>(null)
  const prevAddress = useRef<string | undefined>(undefined)
  // Pending debounced wipe timer for a connected→disconnected transition (H7). Cleared on reconnect.
  const wipeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (prevConnected.current === null) {
      prevConnected.current = isConnected
      prevAddress.current = address
      return
    }
    if (!prevConnected.current && isConnected && address) {
      log('wallet_connected', { address, ens: null })
      // Reconnected (possibly after a transient drop) — cancel any pending destructive wipe so a
      // brief flap during a money flow never destroys the note cache / deposit-index counter (H7/C3).
      if (wipeTimer.current) {
        clearTimeout(wipeTimer.current)
        wipeTimer.current = null
        log('wallet_wipe_cancelled', { reason: 'reconnected', address })
      }
    } else if (prevConnected.current && !isConnected) {
      log('wallet_disconnected', { prevAddress: prevAddress.current })
      // Always drop the in-memory master seed immediately (cheap, non-destructive, FC-13) so a real
      // disconnect doesn't leave it resident. The DESTRUCTIVE localStorage/IndexedDB wipe is deferred.
      clearSession()
      // H7: distinguish a deliberate disconnect from a transient drop (mobile/WalletConnect sessions
      // flap constantly). Defer the destructive wipe; if the wallet reconnects within the window the
      // timer is cancelled above. C3: never wipe while a deposit/withdraw money op is in flight — the
      // encrypted note cache + deposit-index counter must survive until the note is persisted.
      const disconnectedAddress = prevAddress.current
      if (wipeTimer.current) clearTimeout(wipeTimer.current)
      wipeTimer.current = setTimeout(() => {
        wipeTimer.current = null
        if (isMoneyOpInFlight()) {
          // A money op is mid-flight (USDC already moved, note not yet persisted) — skip the wipe to
          // avoid silent fund loss. The flag clears when the op completes/aborts; the next real
          // disconnect (or the in-flight beforeunload guard) covers shared-device hygiene.
          log('wallet_wipe_skipped', { reason: 'money_op_in_flight', prevAddress: disconnectedAddress })
          return
        }
        // FINDING: PRIV-004 — on a CONFIRMED disconnect (still disconnected after the debounce window),
        // wipe persisted note state from localStorage/IndexedDB, not just the in-memory cache. On a
        // shared device, leaving notes/activity/deposit-index would expose the prior user's
        // pseudonymous trading history to the next connector.
        clearNoteCache()
        resetAllLocalState()
        log('wallet_wipe_committed', { prevAddress: disconnectedAddress })
      }, DISCONNECT_WIPE_DELAY_MS)
    } else if (isConnected && address && address !== prevAddress.current) {
      log('wallet_address_changed', { from: prevAddress.current, to: address })
      // FC-13: drop the prior account's in-memory master seed on an account switch (the seed is
      // address-keyed so it's never reused cross-account, but don't let it linger in memory).
      clearSession()
    }
    prevConnected.current = isConnected
    prevAddress.current = address
  }, [isConnected, address])

  // Clean up a pending wipe timer on unmount so it can't fire against a torn-down component.
  useEffect(() => () => { if (wipeTimer.current) clearTimeout(wipeTimer.current) }, [])

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
