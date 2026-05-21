'use client'
import { useState } from 'react'
import { KV } from '@/components/app/KV'

const METRICS = [
  { label: 'Test vaults active', value: '84' },
  { label: 'Proofs generated', value: '2,412' },
  { label: 'Markets tested', value: '18' },
  { label: 'USDC settled (testnet)', value: '$1.4M' },
]

export default function TestnetPage() {
  const [email, setEmail] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const seats = 158
  const totalSeats = 200

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '48px 24px 80px' }}>
      <div className="micro" style={{ color: 'var(--cyan)' }}>TESTNET · POLYGON AMOY</div>
      <h1 className="h2 mt-3" style={{ margin: 0 }}>Join the private beta.</h1>
      <p className="body mt-4" style={{ maxWidth: 580 }}>
        Polyshield is live on Polygon Amoy testnet. We're onboarding a small group of testers to validate the proof flows and UI before mainnet. Testnet USDC is provided — no real funds involved.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginTop: 40 }}>
        <div>
          {!submitted ? (
            <div className="panel" style={{ padding: 28 }}>
              <div className="micro">REQUEST ACCESS</div>
              <div className="mt-4">
                <div className="micro" style={{ fontSize: 10 }}>YOUR EMAIL</div>
                <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" type="email"
                  style={{ width: '100%', marginTop: 8, background: 'var(--bg-1)', border: '1px solid var(--line-strong)', borderRadius: 6, padding: '12px 14px', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 13 }} />
              </div>
              <div className="hairline-t mt-4" style={{ paddingTop: 14 }}>
                <div className="micro" style={{ fontSize: 10, marginBottom: 8 }}>SEATS REMAINING</div>
                <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                  <span className="num" style={{ fontSize: 13 }}>{totalSeats - seats} of {totalSeats}</span>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--text-2)' }}>{Math.round(((totalSeats - seats) / totalSeats) * 100)}% open</span>
                </div>
                <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2 }}>
                  <div style={{ height: 4, width: `${(seats / totalSeats) * 100}%`, background: 'var(--cyan)', borderRadius: 2 }} />
                </div>
              </div>
              <button className="btn btn-primary mt-5" style={{ width: '100%', justifyContent: 'center', padding: '13px 0', fontSize: 13, opacity: email ? 1 : 0.4 }}
                onClick={() => email && setSubmitted(true)}>
                Request testnet access
              </button>
            </div>
          ) : (
            <div className="panel" style={{ padding: 28 }}>
              <div style={{ width: 40, height: 40, borderRadius: 8, background: 'oklch(0.78 0.16 152 / 0.18)', color: 'var(--green)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}>
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth={2.5}><polyline points="20 6 9 17 4 12" /></svg>
              </div>
              <div className="micro" style={{ color: 'var(--green)' }}>REQUEST RECEIVED</div>
              <h3 className="h3 mt-2" style={{ margin: 0 }}>You're on the list.</h3>
              <p className="body mt-3" style={{ fontSize: 13 }}>We'll send testnet credentials to <span className="mono">{email}</span> within 24–48 hours. Testnet USDC and a faucet link will be included.</p>
            </div>
          )}
        </div>

        <div>
          <div className="panel" style={{ padding: 24 }}>
            <div className="micro">LIVE TESTNET METRICS</div>
            <div className="col mt-4 gap-3">
              {METRICS.map(({ label, value }) => (
                <div key={label} className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="small" style={{ fontSize: 12 }}>{label}</span>
                  <span className="num" style={{ fontSize: 14, color: 'var(--cyan)' }}>{value}</span>
                </div>
              ))}
            </div>
            <div className="hairline-t mt-4" style={{ paddingTop: 14 }}>
              <KV l="Network" v="Polygon Amoy" />
              <KV l="Vault contract" v="0x7a4f…c2b9" />
              <KV l="USDC (test)" v="0x41E0…B2f7" />
              <KV l="Block explorer" v="amoy.polygonscan.com" />
            </div>
          </div>

          <div className="panel mt-4" style={{ padding: 24 }}>
            <div className="micro">WHAT YOU'LL TEST</div>
            <div className="col mt-3 gap-2">
              {[
                'Deposit USDC into the vault and generate your note',
                'Browse testnet Polymarket mirrors and authorize bets',
                'Watch the ZK proof generate locally in your browser',
                'Claim settlement credits after markets resolve',
                'Withdraw to any Amoy address via the relay',
                'Export and restore your encrypted note backup',
              ].map((item, i) => (
                <div key={i} className="row gap-3">
                  <span className="mono" style={{ fontSize: 10, color: 'var(--cyan)', minWidth: 20 }}>0{i + 1}</span>
                  <span style={{ fontSize: 12 }}>{item}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
