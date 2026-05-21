'use client'
import { useState } from 'react'
import { Icon, ICONS } from '@/components/ui/Icon'

const PROOFS = [
  { id: 'prf_0x4b81…d23f', type: 'BET_AUTH', market: 'Fed cuts rates Dec?', side: 'YES', amount: 500, status: 'FILLED', age: '8m ago', nullifier: '0x4b81…d23f', tx: '0xa731…fe09' },
  { id: 'prf_0x77ce…be11', type: 'SETTLE_CRED', market: 'GPT5-RELEASE', side: 'YES', amount: 18720, status: 'CREDITED', age: '32m ago', nullifier: '0x77ce…be11', tx: '0xb291…12aa' },
  { id: 'prf_0x91a3…0fc2', type: 'DEPOSIT', market: '—', side: '—', amount: 25000, status: 'CONFIRMED', age: '2h ago', nullifier: '—', tx: '0xc410…9001' },
  { id: 'prf_0x2310…44a1', type: 'DEPOSIT', market: '—', side: '—', amount: 50000, status: 'CONFIRMED', age: '5h ago', nullifier: '—', tx: '0xd112…f820' },
  { id: 'prf_0xa811…3301', type: 'BET_AUTH', market: 'BTC above $150k Dec 31?', side: 'NO', amount: 1000, status: 'FOK_FAILED', age: '3d ago', nullifier: '0xa811…3301', tx: '0xe201…3abc' },
  { id: 'prf_0xc210…f9aa', type: 'CANCEL_CRED', market: 'BTC above $150k Dec 31?', side: 'NO', amount: 1000, status: 'CREDITED', age: '3d ago', nullifier: '0xc210…f9aa', tx: '0xf311…8811' },
  { id: 'prf_0x4404…f9e2', type: 'WITHDRAW', market: '—', side: '—', amount: 5000, status: 'DELIVERED', age: '4d ago', nullifier: '0x4404…f9e2', tx: '0x0120…cc01' },
]

const TYPE_COLOR: Record<string, string> = {
  DEPOSIT: 'var(--cyan)',
  BET_AUTH: 'var(--violet)',
  SETTLE_CRED: 'var(--green)',
  CANCEL_CRED: 'oklch(0.80 0.15 70)',
  WITHDRAW: 'var(--text-2)',
}

const STATUS_COLOR: Record<string, string> = {
  CONFIRMED: 'var(--green)',
  FILLED: 'var(--green)',
  CREDITED: 'var(--green)',
  DELIVERED: 'var(--green)',
  ACTIVE: 'var(--cyan)',
  FOK_FAILED: 'var(--red)',
}

const TYPES = ['ALL', 'DEPOSIT', 'BET_AUTH', 'SETTLE_CRED', 'CANCEL_CRED', 'WITHDRAW']

export default function ProofsPage() {
  const [typeFilter, setTypeFilter] = useState('ALL')
  const filtered = typeFilter === 'ALL' ? PROOFS : PROOFS.filter((p) => p.type === typeFilter)

  const stats = [
    { label: 'Total proofs', value: PROOFS.length },
    { label: 'Bets authorized', value: PROOFS.filter((p) => p.type === 'BET_AUTH').length },
    { label: 'Settlements', value: PROOFS.filter((p) => p.type === 'SETTLE_CRED').length },
    { label: 'FOK failures', value: PROOFS.filter((p) => p.status === 'FOK_FAILED').length },
  ]

  return (
    <div>
      <div className="row hairline-b" style={{ padding: '14px 24px', justifyContent: 'space-between' }}>
        <div className="row gap-4">
          <div className="micro">PROOF LEDGER</div>
          <span className="pill pill-soft" style={{ fontSize: 10 }}>{PROOFS.length} proofs</span>
        </div>
      </div>

      <div style={{ padding: 24 }}>
        {/* Stats row */}
        <div className="row gap-3 mb-5" style={{ marginBottom: 20 }}>
          {stats.map(({ label, value }) => (
            <div key={label} className="panel" style={{ padding: '12px 16px', flex: 1 }}>
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
        <div className="panel" style={{ padding: 0 }}>
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
                  <td className="num" style={{ textAlign: 'right', fontSize: 12 }}>${p.amount.toLocaleString()}</td>
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
