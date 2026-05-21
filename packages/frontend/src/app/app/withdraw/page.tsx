'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { FlowShell, useProgress, CircuitTrace, RelayRouteVisual } from '@/components/app/FlowShell'
import { KV } from '@/components/app/KV'
import { Icon, ICONS } from '@/components/ui/Icon'

const AVAILABLE_NOTES = [
  { id: 'note_0x91a3…0fc2', amount: 25000, kind: 'DEPOSIT', age: '2h ago' },
  { id: 'note_0x2310…44a1', amount: 50000, kind: 'DEPOSIT', age: '5h ago' },
  { id: 'note_0x4404…f9e2', amount: 100000, kind: 'DEPOSIT', age: '1d ago' },
  { id: 'note_0x77ce…be11', amount: 18720, kind: 'SETTLE_CREDIT', age: '32m ago' },
  { id: 'note_0x4b81…d23f', amount: 5985, kind: 'BET_OUTPUT', age: '8m ago' },
]

const BUCKET_LABELS: Record<string, [string, string]> = {
  standard: ['Standard', '3–12 min'],
  fast: ['Fast', '30–90 s · less entropy'],
  paranoid: ['Paranoid', '15–60 min · max entropy'],
}

function Step0({ recipient, setRecipient, selectedNotes, setSelectedNotes, delayBucket, setDelayBucket, onNext }: any) {
  const total = selectedNotes.reduce((acc: number, id: string) => {
    const n = AVAILABLE_NOTES.find((x) => x.id === id)
    return acc + (n ? n.amount : 0)
  }, 0)
  const toggle = (id: string) => setSelectedNotes((arr: string[]) => arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id])

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 32 }}>
      <div>
        <div className="micro">SELECT NOTES TO SPEND</div>
        <h3 className="h3 mt-3" style={{ margin: 0 }}>What's leaving the vault?</h3>
        <p className="body mt-3">Each note you spend becomes a nullifier — publicly visible but unlinkable to its commitment.</p>
        <div className="col gap-2 mt-6">
          {AVAILABLE_NOTES.map((n) => {
            const on = selectedNotes.includes(n.id)
            return (
              <div key={n.id} onClick={() => toggle(n.id)} className="row" style={{ padding: '12px 14px', borderRadius: 6, cursor: 'pointer', background: on ? 'oklch(0.82 0.13 210 / 0.06)' : 'transparent', border: '1px solid', borderColor: on ? 'oklch(0.82 0.13 210 / 0.4)' : 'var(--line-strong)', justifyContent: 'space-between' }}>
                <div className="row gap-3">
                  <span style={{ width: 14, height: 14, borderRadius: 3, border: '1px solid', borderColor: on ? 'var(--cyan)' : 'var(--line-strong)', background: on ? 'oklch(0.82 0.13 210 / 0.2)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {on && <Icon d={ICONS.check} size={10} className="text-cyan" />}
                  </span>
                  <div>
                    <div className="mono" style={{ fontSize: 12 }}>{n.id}</div>
                    <div className="mono small" style={{ fontSize: 10 }}>{n.kind} · {n.age}</div>
                  </div>
                </div>
                <div className="num" style={{ fontSize: 15 }}>${n.amount.toLocaleString()}</div>
              </div>
            )
          })}
        </div>
        <div className="mt-6">
          <div className="micro">DELAY POSTURE</div>
          <div className="row mt-2" style={{ gap: 6 }}>
            {Object.entries(BUCKET_LABELS).map(([k, [name, time]]) => (
              <button key={k} onClick={() => setDelayBucket(k)} className="btn" style={{ flex: 1, flexDirection: 'column', justifyContent: 'center', padding: '10px 12px', background: delayBucket === k ? 'oklch(0.82 0.13 210 / 0.08)' : 'transparent', borderColor: delayBucket === k ? 'oklch(0.82 0.13 210 / 0.5)' : 'var(--line-strong)', color: delayBucket === k ? 'var(--cyan)' : 'var(--text-1)', gap: 2 }}>
                <span style={{ fontSize: 12 }}>{name}</span>
                <span className="mono" style={{ fontSize: 10, color: 'var(--text-2)' }}>{time}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div>
        <div className="micro">RECIPIENT &amp; SUMMARY</div>
        <div className="panel mt-3" style={{ padding: 20 }}>
          <div className="micro">RECIPIENT ADDRESS</div>
          <input value={recipient} onChange={(e: any) => setRecipient(e.target.value)} placeholder="0x… (any EVM address)"
            style={{ width: '100%', marginTop: 6, background: 'var(--bg-1)', border: '1px solid var(--line-strong)', borderRadius: 6, padding: '12px 14px', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 12 }} />
          <div className="hairline-t mt-4" style={{ paddingTop: 12 }}>
            <KV l="Total payout" v={`$${total.toLocaleString()} USDC`} />
            <KV l="Notes spent" v={`${selectedNotes.length}`} />
            <KV l="Relay hops" v="3 randomized" />
            <KV l="Delay posture" v={BUCKET_LABELS[delayBucket][0]} />
            <KV l="Proof circuit" v="WITHDRAW_V1" />
          </div>
          <button onClick={onNext} disabled={!recipient || selectedNotes.length === 0} className="btn btn-primary mt-4"
            style={{ width: '100%', justifyContent: 'center', padding: '14px 0', fontSize: 13, opacity: (!recipient || selectedNotes.length === 0) ? 0.4 : 1, cursor: (!recipient || selectedNotes.length === 0) ? 'not-allowed' : 'pointer' }}>
            Generate withdraw proof <Icon d={ICONS.arrow} size={12} />
          </button>
        </div>
      </div>
    </div>
  )
}

function Step1({ onNext }: { onNext: () => void }) {
  const progress = useProgress(true, 2.5, onNext)
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32 }}>
      <div>
        <div className="micro">PROVING · LOCAL · WASM</div>
        <h3 className="h3 mt-3" style={{ margin: 0 }}>Generating withdraw proof.</h3>
        <p className="body mt-3">The WITHDRAW_V1 circuit proves you know the secrets for the selected notes and that none have already been spent.</p>
        <div className="panel mt-6" style={{ padding: 20 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="mono" style={{ fontSize: 12, color: 'var(--cyan)' }}>composing proof</span>
            <span className="mono" style={{ fontSize: 12 }}>{progress}%</span>
          </div>
          <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, marginTop: 8 }}>
            <div style={{ height: 4, width: `${progress}%`, background: 'var(--cyan)', borderRadius: 2 }} />
          </div>
          <pre className="mono mt-4" style={{ margin: 0, fontSize: 10, color: 'var(--text-2)', lineHeight: 1.6 }}>{`> circuit WITHDRAW_V1.wasm        (612 KB)\n> witnesses: 3,140 constraints\n> nullifier set membership: ok\n> commitment merkle path: ok\n> output binding: recipient hash committed\n> π = 384 bytes`}</pre>
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

function Step2({ delayBucket, onNext }: { delayBucket: string; onNext: () => void }) {
  const speed = delayBucket === 'fast' ? 4 : delayBucket === 'paranoid' ? 0.8 : 1.8
  const progress = useProgress(true, speed, onNext)
  const litHops = Math.min(Math.floor((progress / 100) * 3) + 1, 3)
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32 }}>
      <div>
        <div className="micro">RELAY · ENCRYPTED · DELAYED</div>
        <h3 className="h3 mt-3" style={{ margin: 0 }}>Routing through the relay.</h3>
        <p className="body mt-3">Your proof is encrypted to each hop's public key and held with random jitter. The delay breaks timing correlation between deposit and recipient credit.</p>
        <div className="panel mt-6" style={{ padding: 20 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="mono" style={{ fontSize: 12, color: 'var(--cyan)' }}>hop {litHops} / 3</span>
            <span className="mono" style={{ fontSize: 12 }}>{progress}%</span>
          </div>
          <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, marginTop: 8 }}>
            <div style={{ height: 4, width: `${progress}%`, background: 'var(--cyan)', borderRadius: 2 }} />
          </div>
          <div className="col gap-2 mt-4">
            {['us-east-relay.07', 'eu-west-relay.12', 'ap-relay.04'].map((h, i) => (
              <div key={h} className="row" style={{ justifyContent: 'space-between' }}>
                <div className="row gap-3">
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: i < litHops ? 'var(--cyan)' : 'rgba(255,255,255,0.15)', boxShadow: i < litHops ? '0 0 6px var(--cyan)' : 'none' }} />
                  <span className="mono" style={{ fontSize: 12 }}>{h}</span>
                </div>
                <span className="mono small" style={{ fontSize: 11 }}>{i < litHops ? `+${(140 + i * 80).toFixed(0)}ms` : '...'}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div>
        <div className="micro">ROUTE</div>
        <div className="panel mt-3" style={{ padding: 24 }}>
          <RelayRouteVisual litHops={litHops} />
        </div>
      </div>
    </div>
  )
}

function Step3({ recipient, onDone }: { recipient: string; onDone: () => void }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 32 }}>
      <div>
        <div className="row gap-3">
          <div style={{ width: 40, height: 40, borderRadius: 8, background: 'oklch(0.78 0.16 152 / 0.18)', color: 'var(--green)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon d={ICONS.check} size={20} />
          </div>
          <div>
            <div className="micro" style={{ color: 'var(--green)' }}>WITHDRAWN · RECIPIENT CREDITED</div>
            <h3 className="h3 mt-1" style={{ margin: 0 }}>Funds delivered.</h3>
          </div>
        </div>
        <p className="body mt-4">The recipient address received the withdrawal. The nullifiers for the spent notes are now public; the deposit-to-withdrawal link is not.</p>
        <div className="panel mt-6" style={{ padding: 20 }}>
          <KV l="Recipient" v={recipient || '0x4b81…d23f'} />
          <KV l="Amount delivered" v="$25,000 USDC" />
          <KV l="Withdraw tx" v="0xa731…fe09" />
          <KV l="Nullifiers added" v="1" />
          <KV l="Unlinkability" v="99.8%" />
        </div>
        <div className="row gap-3 mt-6">
          <button className="btn btn-primary" onClick={onDone}>Back to vault</button>
          <button className="btn">View on-chain <Icon d={ICONS.external} size={12} /></button>
        </div>
      </div>
      <div>
        <div className="micro">UNLINKABILITY REPORT</div>
        <div className="panel mt-3" style={{ padding: 20 }}>
          <div className="num" style={{ fontSize: 32, color: 'var(--cyan)' }}>99.8%</div>
          <div className="small" style={{ fontSize: 11 }}>probability that no observer can link this withdrawal to its origin deposit</div>
          <div className="hairline-t mt-4" style={{ paddingTop: 12 }}>
            <KV l="Anonymity set at exit" v="1,842" />
            <KV l="Timing entropy" v="7.4 bits" />
            <KV l="Decoy density" v="12.3%" />
            <KV l="Co-mingled spends" v="14 in window" />
          </div>
        </div>
      </div>
    </div>
  )
}

export default function WithdrawPage() {
  const router = useRouter()
  const [step, setStep] = useState(0)
  const [selectedNotes, setSelectedNotes] = useState(['note_0x91a3…0fc2'])
  const [recipient, setRecipient] = useState('')
  const [delayBucket, setDelayBucket] = useState('standard')
  const steps: [string, string, string][] = [
    ['01', 'Select notes', 'Choose which notes to spend and where to send.'],
    ['02', 'Prove withdrawal', 'Local WITHDRAW_V1 proof. Spends nullifiers.'],
    ['03', 'Relay & delay', 'Onion-routed with timing jitter.'],
    ['04', 'Done', 'Funds delivered. Recipient is unlinkable.'],
  ]
  return (
    <FlowShell title="Withdraw to a recipient" kicker="WITHDRAW · PRIVATE" summary={`${selectedNotes.length} note(s) · vault → recipient`} steps={steps} step={step} onBack={() => router.push('/app/vault')}>
      {step === 0 && <Step0 recipient={recipient} setRecipient={setRecipient} selectedNotes={selectedNotes} setSelectedNotes={setSelectedNotes} delayBucket={delayBucket} setDelayBucket={setDelayBucket} onNext={() => setStep(1)} />}
      {step === 1 && <Step1 onNext={() => setStep(2)} />}
      {step === 2 && <Step2 delayBucket={delayBucket} onNext={() => setStep(3)} />}
      {step === 3 && <Step3 recipient={recipient} onDone={() => router.push('/app/vault')} />}
    </FlowShell>
  )
}
