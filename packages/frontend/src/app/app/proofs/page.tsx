'use client'
import { useState } from 'react'
import { Icon, ICONS } from '@/components/ui/Icon'
import { PrivacyModel } from '@/components/app/PrivacyModel'

// H2: synthetic placeholders only. No concrete amounts, hashes, ages, or "DELIVERED"
// statuses that a returning user could mistake for their own real account history. The
// rows exist purely to show the SHAPE of the ledger; every value is obviously a sample.
const PROOFS: Array<{
  id: string; type: string; market: string; side: string
  amount: number | null; status: string; age: string; nullifier: string; tx: string
}> = [
  { id: 'prf_SAMPLE', type: 'BET_AUTH', market: 'Example market', side: 'YES', amount: null, status: 'SAMPLE', age: '—', nullifier: '0x…', tx: '0x…' },
  { id: 'prf_SAMPLE', type: 'SETTLE_CRED', market: 'Example market', side: 'YES', amount: null, status: 'SAMPLE', age: '—', nullifier: '0x…', tx: '0x…' },
  { id: 'prf_SAMPLE', type: 'DEPOSIT', market: '—', side: '—', amount: null, status: 'SAMPLE', age: '—', nullifier: '—', tx: '0x…' },
  { id: 'prf_SAMPLE', type: 'BET_AUTH', market: 'Example market', side: 'NO', amount: null, status: 'SAMPLE', age: '—', nullifier: '0x…', tx: '0x…' },
  { id: 'prf_SAMPLE', type: 'CANCEL_CRED', market: 'Example market', side: 'NO', amount: null, status: 'SAMPLE', age: '—', nullifier: '0x…', tx: '0x…' },
  { id: 'prf_SAMPLE', type: 'WITHDRAW', market: '—', side: '—', amount: null, status: 'SAMPLE', age: '—', nullifier: '0x…', tx: '0x…' },
]

const TYPE_COLOR: Record<string, string> = {
  DEPOSIT: 'var(--cyan)',
  BET_AUTH: 'var(--violet)',
  SETTLE_CRED: 'var(--green)',
  CANCEL_CRED: 'var(--amber)',
  WITHDRAW: 'var(--text-2)',
}

const STATUS_COLOR: Record<string, string> = {
  CONFIRMED: 'var(--green)',
  FILLED: 'var(--green)',
  CREDITED: 'var(--green)',
  DELIVERED: 'var(--green)',
  ACTIVE: 'var(--cyan)',
  UNFILLED: 'var(--red)',
}

const TYPES = ['ALL', 'DEPOSIT', 'BET_AUTH', 'SETTLE_CRED', 'CANCEL_CRED', 'WITHDRAW']

export default function ProofsPage() {
  const [typeFilter, setTypeFilter] = useState('ALL')
  const filtered = typeFilter === 'ALL' ? PROOFS : PROOFS.filter((p) => p.type === typeFilter)

  // H2: do NOT compute live-looking counts off the sample rows — a returning user could read
  // them as real activity. Show neutral placeholders until the real per-account feed is wired.
  const stats = [
    { label: 'Total proofs', value: '—' },
    { label: 'Bets authorized', value: '—' },
    { label: 'Settlements', value: '—' },
    { label: 'Unfilled orders', value: '—' },
  ]

  return (
    <div>
      <div className="row hairline-b" style={{ padding: '14px 24px', justifyContent: 'space-between' }}>
        <div className="row gap-4">
          <div className="micro">PROOF LEDGER</div>
          <span className="pill pill-soft" style={{ fontSize: 10 }}>Sample</span>
        </div>
        <span className="pill pill-amber" style={{ fontSize: 10 }}>PREVIEW · SAMPLE DATA</span>
      </div>

      <div style={{ padding: 24 }}>
        {/* Honest framing: the rows below are illustrative sample data, not the connected
            account's real proof history (the per-account proof feed isn't wired yet). Showing
            specific-looking proofs as if real would be a trust violation. Mirrors /app/privacy. */}
        <div className="callout" style={{ borderColor: 'var(--amber)', padding: '12px 16px', marginBottom: 20, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--amber)', flexShrink: 0, marginTop: 5 }} />
          <div className="small" style={{ fontSize: 12, color: 'var(--text-1)' }}>
            <strong style={{ color: 'var(--text)' }}>Illustrative preview.</strong> These proofs are sample data that
            show how your proof ledger will look — they are <em>not</em> your account’s real proofs. Your live proof
            history (deposits, bets, settlements, withdrawals) is visible in the{' '}
            <a href="/explorer" style={{ color: 'var(--cyan)' }}>explorer</a>.
          </div>
        </div>

        {/* The honest privacy boundary, stated before the guarantees list (which is positive-only):
            deposits are public, only bet-authorship is hidden. */}
        <PrivacyModel style={{ marginBottom: 20 }} />

        {/* Stats row */}
        <div className="row gap-3 mb-5" style={{ marginBottom: 20, flexWrap: 'wrap' }}>
          {stats.map(({ label, value }) => (
            <div key={label} className="panel" style={{ padding: '12px 16px', flex: '1 1 140px' }}>
              <div className="micro" style={{ fontSize: 9 }}>{label.toUpperCase()}</div>
              <div className="num mt-1" style={{ fontSize: 22 }}>{value}</div>
            </div>
          ))}
        </div>

        {/* Type filter */}
        <div className="row gap-2" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
          {TYPES.map((t) => (
            <button key={t} onClick={() => setTypeFilter(t)} className={`btn btn-sm ${typeFilter === t ? 'btn-cyan' : ''}`} style={{ fontSize: 10 }}>{t}</button>
          ))}
        </div>

        {/* Proof table */}
        <div className="panel scroll-x" style={{ padding: 0 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Proof ID</th>
                <th>Type</th>
                <th>Market</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
                <th>Status</th>
                <th>Nullifier</th>
                <th>Tx</th>
                <th>Age</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.id}>
                  <td className="mono" style={{ fontSize: 10 }}>{p.id}</td>
                  <td>
                    <span className="pill" style={{ fontSize: 9, background: 'transparent', border: '1px solid', borderColor: TYPE_COLOR[p.type] ?? 'var(--line-strong)', color: TYPE_COLOR[p.type] ?? 'var(--text-2)' }}>
                      {p.type}
                    </span>
                  </td>
                  <td style={{ fontSize: 12, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.market}</td>
                  <td className="num" style={{ textAlign: 'right', fontSize: 12, color: 'var(--text-3)' }}>{p.amount == null ? '$—' : `$${p.amount.toLocaleString()}`}</td>
                  <td>
                    <span style={{ fontSize: 10, color: STATUS_COLOR[p.status] ?? 'var(--text-2)' }}>{p.status}</span>
                  </td>
                  <td className="mono" style={{ fontSize: 10, color: 'var(--text-2)' }}>{p.nullifier}</td>
                  <td className="mono" style={{ fontSize: 10, color: 'var(--text-2)' }}>{p.tx}</td>
                  <td className="small">{p.age}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="panel mt-4" style={{ padding: 16 }}>
          <div className="micro">CRYPTOGRAPHIC GUARANTEES</div>
          <div className="row mt-3 gap-6" style={{ flexWrap: 'wrap' }}>
            {[
              ['Nullifier unlinkability', 'Each nullifier is derived from your secret. It proves you spent a note without revealing which deposit created it.'],
              ['Commitment hiding', 'Your note commitments are Poseidon hashes — no observer can determine amount or secret from the on-chain leaf.'],
              ['Relay non-association', 'The Proof Relay submits transactions; your wallet never appears in bet/settle/withdraw tx calldata.'],
            ].map(([t, s]) => (
              <div key={t as string} style={{ flex: '1 1 200px' }}>
                <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 4 }}>{t as string}</div>
                <div className="small" style={{ fontSize: 11 }}>{s as string}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
