'use client'

import { useEffect, useRef, useState } from 'react'
import { useSignMessage } from 'wagmi'
import { Logo } from '@/components/ui/Logo'
import { consentMessage, hasLocalConsent, fetchConsent, submitConsent } from '@/lib/betaConsent'

type Phase = 'checking' | 'needed' | 'consented'

/**
 * Blocks the dApp until the connected wallet has signed the beta terms acknowledgement once.
 * Sits inside the connected + correct-network gate in AppLayout, so `address` is always present
 * and on the right chain by the time this renders. The signature is a plain personal_sign of a
 * fixed disclaimer — it is NOT a transaction and never touches the on-chain privacy invariant.
 */
export function BetaConsentGate({ address, children }: { address: string; children: React.ReactNode }) {
  const { signMessageAsync } = useSignMessage()
  const [phase, setPhase] = useState<Phase>('checking')
  const [signing, setSigning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const checkedFor = useRef<string | null>(null)

  // Resolve consent for the current address: trust a local flag, else ask the relay (so a returning
  // user on a fresh device isn't re-prompted), else require a signature.
  useEffect(() => {
    let cancelled = false
    checkedFor.current = address
    setError(null)
    if (hasLocalConsent(address)) {
      setPhase('consented')
      return
    }
    setPhase('checking')
    fetchConsent(address).then((ok) => {
      if (cancelled || checkedFor.current !== address) return
      setPhase(ok ? 'consented' : 'needed')
    })
    return () => {
      cancelled = true
    }
  }, [address])

  async function onAgree() {
    setError(null)
    setSigning(true)
    try {
      const signature = await signMessageAsync({ message: consentMessage(address) })
      await submitConsent(address, signature)
      setPhase('consented')
    } catch (err) {
      // User rejected, or the relay couldn't record it. Stay gated.
      setError(err instanceof Error && /reject|denied/i.test(err.message) ? 'Signature was rejected.' : (err instanceof Error ? err.message : 'Could not record acknowledgement.'))
    } finally {
      setSigning(false)
    }
  }

  if (phase === 'consented') return <>{children}</>
  if (phase === 'checking') return null

  return (
    <div style={{ minHeight: 'calc(100vh - 56px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div className="panel" style={{ padding: 40, maxWidth: 480, width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <Logo size={36} withText={false} />
        </div>
        <h2 className="h3 mt-6" style={{ margin: 0, textAlign: 'center' }}>Beta acknowledgement</h2>
        <p className="body mt-4" style={{ fontSize: 13, lineHeight: 1.6 }}>
          PolyShield is <strong>experimental beta software</strong> live on Polygon mainnet with
          real funds. By continuing you acknowledge that you use it entirely at your own risk and
          that the PolyShield operators and contributors are <strong>not liable for any loss of
          funds</strong>. You confirm you are not restricted from using this protocol under
          applicable law.
        </p>
        <p className="small mt-4" style={{ fontSize: 12, color: 'var(--text-2)' }}>
          Sign once to record your acknowledgement. This is a message signature — not a transaction,
          and it costs nothing.
        </p>
        {error && (
          <div className="mt-4" style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>
        )}
        <div className="mt-6" style={{ display: 'flex', justifyContent: 'center' }}>
          <button
            className="btn btn-primary"
            onClick={onAgree}
            disabled={signing}
            style={{ padding: '12px 28px' }}
          >
            {signing ? 'Awaiting signature…' : 'I agree — sign to continue'}
          </button>
        </div>
      </div>
    </div>
  )
}
