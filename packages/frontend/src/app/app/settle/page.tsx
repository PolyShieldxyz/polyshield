'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { FlowShell, useProgress, CircuitTrace } from '@/components/app/FlowShell'
import { KV } from '@/components/app/KV'
import { Icon, ICONS } from '@/components/ui/Icon'

const CLAIMABLE = [
  { id: 'set_0x77ce…be11', market: 'GPT5-RELEASE', side: 'YES', shares: 18720, payout: 18720, resolved: 'Mar 14 · YES' },
  { id: 'set_0x91a2…11cc', market: 'ETH-MERGE-2024-RECAP', side: 'YES', shares: 4200, payout: 4200, resolved: 'Mar 12 · YES' },
  { id: 'set_0x44ad…77f0', market: 'CPI-FEB-UNDER', side: 'NO', shares: 1800, payout: 1800, resolved: 'Mar 12 · NO' },
]

function Step0({ selected, setSelected, onNext }: { selected: number; setSelected: (i: number) => void; onNext: () => void }) {
  const claim = CLAIMABLE[selected]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 32 }}>
      <div>
        <div className="micro">CLAIMABLE SETTLEMENTS</div>
        <h3 className="h3 mt-3" style={{ margin: 0 }}>Pick a resolved position.</h3>
        <p className="body mt-3">Each market resolves on-chain through the SETTLE_CRED circuit. Your share of the payout becomes a fresh private note — unlinkable to the original bet authorization.</p>
        <div className="col mt-6 gap-2">
          {CLAIMABLE.map((c, i) => (
            <div key={c.id} onClick={() => setSelected(i)} className="row" style={{ padding: '14px 16px', borderRadius: 6, cursor: 'pointer', background: i === selected ? 'oklch(0.82 0.13 210 / 0.06)' : 'transparent', border: '1px solid', borderColor: i === selected ? 'oklch(0.82 0.13 210 / 0.4)' : 'var(--line-strong)', justifyContent: 'space-between' }}>
              <div className="row gap-3">
                <span style={{ width: 14, height: 14, borderRadius: '50%', border: '1px solid', borderColor: i === selected ? 'var(--cyan)' : 'var(--line-strong)', background: i === selected ? 'var(--cyan)' : 'transparent' }} />
                <div>
                  <div style={{ fontSize: 13 }}>{c.market}</div>
                  <div className="mono small" style={{ fontSize: 11 }}>{c.shares.toLocaleString()} shr · {c.side} · resolved {c.resolved}</div>
                </div>
              </div>
              <div className="num" style={{ fontSize: 16, color: 'var(--green)' }}>+${c.payout.toLocaleString()}</div>
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="micro">SUMMARY</div>
        <div className="panel mt-3" style={{ padding: 20 }}>
          <KV l="Market" v={claim.market} />
          <KV l="Resolved" v={claim.resolved} />
          <KV l="Your shares" v={claim.shares.toLocaleString()} />
          <KV l="Side" v={claim.side} />
          <KV l="Payout" v={`$${claim.payout.toLocaleString()} USDC`} />
          <KV l="Credit form" v="private note" />
          <KV l="Circuit" v="SETTLE_CRED" />
          <button className="btn btn-primary mt-4" style={{ width: '100%', justifyContent: 'center', padding: '14px 0', fontSize: 13 }} onClick={onNext}>
            Generate settlement proof <Icon d={ICONS.arrow} size={12} />
          </button>
        </div>
      </div>
    </div>
  )
}

function Step1({ onNext }: { onNext: () => void }) {
  const progress = useProgress(true, 3, onNext)
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32 }}>
      <div>
        <div className="micro">PROVING · LOCAL · WASM</div>
        <h3 className="h3 mt-3" style={{ margin: 0 }}>Generating settlement proof.</h3>
        <p className="body mt-3">SETTLE_CRED proves you held a winning position in the resolved market without revealing which note authorized the original bet.</p>
        <div className="panel mt-6" style={{ padding: 20 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="mono" style={{ fontSize: 12, color: 'var(--cyan)' }}>composing proof</span>
            <span className="mono" style={{ fontSize: 12 }}>{progress}%</span>
          </div>
          <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, marginTop: 8 }}>
            <div style={{ height: 4, width: `${progress}%`, background: 'var(--cyan)', borderRadius: 2 }} />
          </div>
          <pre className="mono mt-4" style={{ margin: 0, fontSize: 10, color: 'var(--text-2)', lineHeight: 1.6 }}>{`> circuit SETTLE_CRED.wasm       (520 KB)\n> resolved market root: 0x91…ae\n> claim merkle path: ok\n> share count attested\n> credit note bound to claim\n> π = 384 bytes`}</pre>
        </div>
      </div>
      <div>
        <div className="micro">CIRCUIT TRACE</div>
        <div className="panel mt-3" style={{ padding: 24 }}>
          <CircuitTrace progress={progress} />
        </div>
      </div>
    </div>
  )
}

function Step2({ onDone }: { onDone: () => void }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 32 }}>
      <div>
        <div className="row gap-3">
          <div style={{ width: 40, height: 40, borderRadius: 8, background: 'oklch(0.78 0.16 152 / 0.18)', color: 'var(--green)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon d={ICONS.check} size={20} />
          </div>
          <div>
            <div className="micro" style={{ color: 'var(--green)' }}>CREDITED · NEW NOTE ADDED</div>
            <h3 className="h3 mt-1" style={{ margin: 0 }}>Settlement claimed.</h3>
          </div>
        </div>
        <p className="body mt-4">The credit is live in your vault as a fresh private note. You can spend it on a new bet, withdraw it, or hold.</p>
        <div className="panel mt-6" style={{ padding: 20 }}>
          <KV l="Credit amount" v="+$18,720 USDC" />
          <KV l="New note ID" v="note_0x77ce…be11" />
          <KV l="Settlement tx" v="0xa731…fe09" />
          <KV l="Circuit" v="SETTLE_CRED" />
          <KV l="Note state" v="OPEN · spendable" />
        </div>
        <div className="row gap-3 mt-6">
          <button className="btn btn-primary" onClick={onDone}>Back to vault</button>
          <button className="btn" onClick={onDone}>Withdraw to wallet</button>
          <button className="btn btn-ghost">View on-chain <Icon d={ICONS.external} size={12} /></button>
        </div>
      </div>
      <div>
        <div className="panel" style={{ padding: 20 }}>
          <div className="micro">WHAT JUST HAPPENED</div>
          <div className="col mt-3 gap-3">
            {[['Market resolved on-chain', 'The oracle posted a final resolution; market root updated.'], ['Your claim verified', 'The proof bound your share count to the resolved outcome.'], ['New private note minted', 'Credit lands in your vault, unlinkable to the original bet.']].map(([t, s], i) => (
              <div key={i} className="row gap-3">
                <span className="mono" style={{ fontSize: 11, color: 'var(--cyan)', minWidth: 22 }}>0{i + 1}</span>
                <div>
                  <div style={{ fontSize: 13 }}>{t}</div>
                  <div className="small" style={{ fontSize: 11 }}>{s}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function SettlePage() {
  const router = useRouter()
  const [step, setStep] = useState(0)
  const [selected, setSelected] = useState(0)
  const steps: [string, string, string][] = [
    ['01', 'Select claim', 'Pick a resolved position to credit.'],
    ['02', 'Prove settlement', 'Local SETTLE_CRED proof.'],
    ['03', 'Done', 'Credit note added to vault.'],
  ]
  return (
    <FlowShell title="Claim settlement credit" kicker="SETTLE · PRIVATE" summary="Credit goes to a new private note" steps={steps} step={step} onBack={() => router.push('/app/vault')}>
      {step === 0 && <Step0 selected={selected} setSelected={setSelected} onNext={() => setStep(1)} />}
      {step === 1 && <Step1 onNext={() => setStep(2)} />}
      {step === 2 && <Step2 onDone={() => router.push('/app/vault')} />}
    </FlowShell>
  )
}
