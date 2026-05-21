'use client'
import { Suspense, useState, useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { keccak256, toBytes, toHex, parseUnits } from 'viem'
import { FlowShell, CircuitTrace } from '@/components/app/FlowShell'
import { KV } from '@/components/app/KV'
import { Icon, ICONS } from '@/components/ui/Icon'
import { getNotes, computeCommitment, computeNullifier, markNoteSpent, addNote, formatUsdc, type Note } from '@/lib/notes'
import { relayBet, MOCK_PROOF, MOCK_ROOT } from '@/lib/api'

const IS_DEV = process.env.NEXT_PUBLIC_DEV_MODE === 'true'

function short(hex: string) { return hex.slice(0, 8) + '…' + hex.slice(-6) }

function marketToBytes32(name: string): `0x${string}` {
  return keccak256(toBytes(name))
}
function positionToBytes32(marketId: string, side: string): `0x${string}` {
  return keccak256(toBytes(marketId + side))
}

// ── Step 0: compose bet ──────────────────────────────────────────────────────

function Step0({
  market, side, price, stake, setStake, selectedNote, setSelectedNote, notes, onNext,
}: {
  market: string; side: string; price: number
  stake: number; setStake: (v: number) => void
  selectedNote: Note | null; setSelectedNote: (n: Note) => void
  notes: Note[]
  onNext: () => void
}) {
  const shares = stake && price ? Math.floor((stake * 100_000_000) / price) : 0
  const insufficient = selectedNote ? parseUnits(String(stake), 6) > selectedNote.balance : false
  const canNext = stake > 0 && !!selectedNote && !insufficient

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 32 }}>
      <div>
        <div className="micro">BET DETAILS</div>
        <h3 className="h3 mt-3" style={{ margin: 0 }}>Compose your bet.</h3>
        <p className="body mt-3">Your bet will be authorized via a ZK proof. The vault&apos;s single EOA will sign and submit the order — your address never appears.</p>

        <div className="mt-6">
          <div className="micro">MARKET</div>
          <div className="panel mt-2" style={{ padding: '12px 14px' }}>
            <div style={{ fontSize: 13 }}>{market}</div>
            <div className="mono small mt-1" style={{ fontSize: 11 }}>
              Side: <span style={{ color: side === 'YES' ? 'var(--green)' : 'var(--red)' }}>{side}</span>
              &nbsp;· Price: {(price / 1e6).toFixed(2)} USDC
            </div>
          </div>
        </div>

        <div className="mt-4">
          <div className="micro">STAKE AMOUNT (USDC)</div>
          <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg-1)', border: `1px solid ${insufficient ? 'var(--red)' : 'var(--line-strong)'}`, borderRadius: 6, padding: '0 14px', marginTop: 8 }}>
            <span className="mono" style={{ color: 'var(--text-2)', marginRight: 8, fontSize: 18 }}>$</span>
            <input type="number" value={stake} onChange={(e) => setStake(Math.max(0, +e.target.value || 0))}
              style={{ background: 'transparent', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 24, padding: '14px 0', width: '100%' }} />
          </div>
          {insufficient && <div className="small mt-1" style={{ fontSize: 11, color: 'var(--red)' }}>Stake exceeds note balance (${formatUsdc(selectedNote!.balance)})</div>}
          <div className="row mt-2 gap-2">
            {[100, 500, 1000, 5000].map((v) => (
              <button key={v} onClick={() => setStake(v)} className={`btn btn-sm ${stake === v ? 'btn-cyan' : 'btn-ghost'}`} style={{ flex: 1, justifyContent: 'center', fontSize: 11 }}>
                ${v >= 1000 ? `${v / 1000}k` : v}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4">
          <div className="micro">SPEND FROM NOTE</div>
          {notes.length === 0 ? (
            <div className="panel mt-2" style={{ padding: 16 }}>
              <div className="small" style={{ color: 'var(--text-2)', fontSize: 12 }}>No spendable notes. <a href="/app/deposit" style={{ color: 'var(--cyan)' }}>Deposit USDC first.</a></div>
            </div>
          ) : (
            <div className="col gap-2 mt-2">
              {notes.map((n) => (
                <div key={n.id} onClick={() => setSelectedNote(n)} className="row"
                  style={{ padding: '12px 14px', borderRadius: 6, cursor: 'pointer', justifyContent: 'space-between', border: '1px solid', borderColor: selectedNote?.id === n.id ? 'oklch(0.82 0.13 210 / 0.4)' : 'var(--line-strong)', background: selectedNote?.id === n.id ? 'oklch(0.82 0.13 210 / 0.06)' : 'transparent' }}>
                  <div className="row gap-3">
                    <span style={{ width: 14, height: 14, borderRadius: '50%', border: '1px solid', borderColor: selectedNote?.id === n.id ? 'var(--cyan)' : 'var(--line-strong)', background: selectedNote?.id === n.id ? 'var(--cyan)' : 'transparent' }} />
                    <span className="mono" style={{ fontSize: 11 }}>{short(n.id)}</span>
                    <span className="pill pill-soft" style={{ fontSize: 9 }}>{n.kind}</span>
                  </div>
                  <span className="num" style={{ fontSize: 13 }}>${formatUsdc(n.balance)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div>
        <div className="micro">SUMMARY</div>
        <div className="panel mt-3" style={{ padding: 20 }}>
          <KV l="Market" v={market.length > 30 ? market.slice(0, 30) + '…' : market} />
          <KV l="Side" v={side} />
          <KV l="Price" v={`${(price / 1e6).toFixed(2)} USDC`} />
          <KV l="Stake" v={`$${stake.toLocaleString()} USDC`} />
          <KV l="Expected shares" v={shares.toLocaleString()} />
          <KV l="Proof circuit" v="BET_AUTH" />
          <KV l="Submission" v="via Proof Relay" />
          {IS_DEV && <KV l="Mode" v="DEV — mock proof (instant)" />}
          <button
            className="btn btn-primary mt-4"
            style={{ width: '100%', justifyContent: 'center', padding: '14px 0', fontSize: 13, opacity: canNext ? 1 : 0.4 }}
            onClick={canNext ? onNext : undefined}
          >
            Generate bet proof <Icon d={ICONS.arrow} size={12} />
          </button>
          {notes.length === 0 && (
            <div className="small mt-2" style={{ textAlign: 'center', color: 'var(--text-3)', fontSize: 11 }}>No notes — deposit USDC first</div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Step 1: "proving" (dev mode = instant mock, prod = WASM) ─────────────────

function Step1({ onNext }: { onNext: () => void }) {
  const [pct, setPct] = useState(0)
  const done = useRef(false)

  useEffect(() => {
    if (IS_DEV) {
      // Dev mode: mock proof is instant — animate briefly for UX clarity
      const t = setInterval(() => {
        setPct((p) => {
          const next = Math.min(p + 8, 100)
          if (next === 100 && !done.current) { done.current = true; clearInterval(t); setTimeout(onNext, 400) }
          return next
        })
      }, 80)
      return () => clearInterval(t)
    } else {
      // Production: WASM prover runs here (not yet implemented)
      setPct(0)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32 }}>
      <div>
        <div className="micro">PROVING · {IS_DEV ? 'DEV MODE (MOCK)' : 'LOCAL · WASM'}</div>
        <h3 className="h3 mt-3" style={{ margin: 0 }}>Generating bet authorization proof.</h3>
        <p className="body mt-3">BET_AUTH proves your note&apos;s balance covers the stake and nullifies it — without revealing which wallet deposited.</p>
        {IS_DEV && (
          <div className="panel mt-3" style={{ padding: 14, borderColor: 'oklch(0.82 0.13 210 / 0.3)', background: 'oklch(0.82 0.13 210 / 0.03)' }}>
            <div className="small" style={{ fontSize: 11, color: 'var(--cyan)' }}>Dev mode: using mock proof (0x00…00). MockVerifier on Anvil accepts it.</div>
          </div>
        )}
        <div className="panel mt-4" style={{ padding: 20 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="mono" style={{ fontSize: 12, color: 'var(--cyan)' }}>{pct < 100 ? 'composing proof…' : 'proof ready'}</span>
            <span className="mono" style={{ fontSize: 12 }}>{pct}%</span>
          </div>
          <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, marginTop: 8 }}>
            <div style={{ height: 4, width: `${pct}%`, background: 'var(--cyan)', borderRadius: 2, transition: 'width .08s linear' }} />
          </div>
          <pre className="mono mt-4" style={{ margin: 0, fontSize: 10, color: 'var(--text-2)', lineHeight: 1.6 }}>{`> circuit BET_AUTH\n> witnesses: balance ≥ stake ✓\n> nullifier = keccak(secret, nonce)\n> new_commitment = keccak(secret, bal', nonce')\n> shares arithmetic: u128 safe ✓\n> π = ${IS_DEV ? '64 bytes (mock)' : '384 bytes (UltraPLONK)'}`}</pre>
        </div>
      </div>
      <div>
        <div className="micro">CIRCUIT TRACE</div>
        <div className="panel mt-3" style={{ padding: 24 }}>
          <CircuitTrace progress={pct} />
        </div>
      </div>
    </div>
  )
}

// ── Step 2: relay ────────────────────────────────────────────────────────────

function Step2({
  relaying, txHash, error, pct,
}: {
  relaying: boolean; txHash: string; error: string | null; pct: number
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32 }}>
      <div>
        <div className="micro">RELAY · SUBMITTING ON-CHAIN</div>
        <h3 className="h3 mt-3" style={{ margin: 0 }}>Relaying proof to Vault.</h3>
        <p className="body mt-3">The Proof Relay submits authorizeBet() on your behalf. Your wallet never signs this transaction — the relay&apos;s EOA pays gas.</p>
        {error && (
          <div className="panel mt-3" style={{ padding: 14, borderColor: 'var(--red)', background: 'oklch(0.70 0.18 25 / 0.06)' }}>
            <div className="small" style={{ color: 'var(--red)', fontSize: 12 }}>Relay error: {error}</div>
          </div>
        )}
        <div className="panel mt-4" style={{ padding: 20 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="mono" style={{ fontSize: 12, color: 'var(--cyan)' }}>{relaying ? 'awaiting confirmation…' : txHash ? 'confirmed' : 'starting relay…'}</span>
            <span className="mono" style={{ fontSize: 12 }}>{pct}%</span>
          </div>
          <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, marginTop: 8 }}>
            <div style={{ height: 4, width: `${pct}%`, background: 'var(--cyan)', borderRadius: 2, transition: 'width .5s ease' }} />
          </div>
          <pre className="mono mt-4" style={{ margin: 0, fontSize: 10, color: 'var(--text-2)', lineHeight: 1.6 }}>{`> POST /api/relay/bet → proof relay\n> Vault.authorizeBet() tx sent\n> awaiting 1 block confirmation\n> BetAuthorized event emitted\n> Signing Layer received`}</pre>
          {txHash && (
            <div className="mono mt-3" style={{ fontSize: 9, color: 'var(--green)' }}>tx: {short(txHash)}</div>
          )}
        </div>
      </div>
      <div>
        <div className="micro">WHAT HAPPENS NEXT</div>
        <div className="panel mt-3" style={{ padding: 20 }}>
          <div className="col gap-3">
            {[
              ['Proof verified on-chain', 'The Vault contract confirms your ZK proof is valid.'],
              ['Signing Layer listens', 'The BetAuthorized event triggers the signing layer.'],
              ['FOK order submitted', 'The vault EOA signs and submits a Fill-Or-Kill order.'],
              ['Position or refund', 'Fill → shares credited. No fill → cancel credit issued.'],
            ].map(([t, s], i) => (
              <div key={i} className="row gap-3">
                <span className="mono" style={{ fontSize: 11, color: 'var(--cyan)', minWidth: 22 }}>0{i + 1}</span>
                <div><div style={{ fontSize: 12 }}>{t}</div><div className="small" style={{ fontSize: 11 }}>{s}</div></div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Step 3: done ─────────────────────────────────────────────────────────────

function Step3({ market, side, stake, txHash, nullifier, onDone }: { market: string; side: string; stake: number; txHash: string; nullifier: string; onDone: () => void }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 32 }}>
      <div>
        <div className="row gap-3">
          <div style={{ width: 40, height: 40, borderRadius: 8, background: 'oklch(0.78 0.16 152 / 0.18)', color: 'var(--green)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon d={ICONS.check} size={20} />
          </div>
          <div>
            <div className="micro" style={{ color: 'var(--green)' }}>BET AUTHORIZED · AWAITING FILL</div>
            <h3 className="h3 mt-1" style={{ margin: 0 }}>Proof submitted.</h3>
          </div>
        </div>
        <p className="body mt-4">Your bet authorization proof is on-chain. The Signing Layer will submit a FOK order within seconds. Check your proofs page for status updates.</p>
        <div className="panel mt-6" style={{ padding: 20 }}>
          <KV l="Market" v={market.length > 30 ? market.slice(0, 30) + '…' : market} />
          <KV l="Side" v={side} />
          <KV l="Stake" v={`$${stake.toLocaleString()} USDC`} />
          <KV l="Nullifier" v={nullifier ? short(nullifier) : '—'} />
          <KV l="Auth tx" v={txHash ? short(txHash) : '—'} />
          <KV l="Status" v="ACTIVE · awaiting fill" />
        </div>
        <div className="row gap-3 mt-6">
          <button className="btn btn-primary" onClick={onDone}>Back to vault</button>
          <button className="btn" onClick={() => { window.location.href = '/app/proofs' }}>View proof activity</button>
        </div>
      </div>
      <div>
        <div className="panel" style={{ padding: 20 }}>
          <div className="micro">PRIVACY PRESERVED</div>
          <div className="col mt-3 gap-3">
            {[
              ['Your address is hidden', 'Only the vault EOA appears in the CLOB order.'],
              ['Bet linked to nullifier only', 'The nullifier is public but unlinkable to your note.'],
              ['FOK prevents partial exposure', 'All-or-nothing fill prevents order book fingerprinting.'],
            ].map(([t, s], i) => (
              <div key={i} className="row gap-3">
                <span className="mono" style={{ fontSize: 11, color: 'var(--cyan)', minWidth: 22 }}>0{i + 1}</span>
                <div><div style={{ fontSize: 12 }}>{t}</div><div className="small" style={{ fontSize: 11 }}>{s}</div></div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Inner page (uses useSearchParams) ────────────────────────────────────────

function BetPageInner() {
  const router = useRouter()
  const params = useSearchParams()
  const market = params.get('market') ?? 'Fed cuts rates in December meeting?'
  const side = (params.get('side') ?? 'YES') as 'YES' | 'NO'
  const price = Number(params.get('price') ?? '710000')

  const [step, setStep] = useState(0)
  const [stake, setStake] = useState(500)
  const [notes] = useState<Note[]>(() => getNotes().filter((n) => !n.spent))
  const [selectedNote, setSelectedNote] = useState<Note | null>(notes[0] ?? null)

  // Relay state
  const [relaying, setRelaying] = useState(false)
  const [relayTxHash, setRelayTxHash] = useState('')
  const [relayError, setRelayError] = useState<string | null>(null)
  const [relayPct, setRelayPct] = useState(0)
  const [nullifier, setNullifier] = useState('')

  const steps: [string, string, string][] = [
    ['01', 'Compose', 'Set stake, side, and source note.'],
    ['02', 'Prove',   'Local BET_AUTH ZK proof.'],
    ['03', 'Relay',   'Submit proof via relay; vault EOA signs.'],
    ['04', 'Done',    'Position authorized and awaiting fill.'],
  ]

  async function handleRelay() {
    if (!selectedNote) return
    setStep(2)
    setRelaying(true)
    setRelayPct(20)
    setRelayError(null)

    const stakeMicro = parseUnits(String(stake), 6)
    const newBalance = selectedNote.balance - stakeMicro
    const newNonce = selectedNote.nonce + 1n
    const newCommitment = computeCommitment(selectedNote.secret, newBalance, newNonce)
    const nullifierHex = computeNullifier(selectedNote.secret, selectedNote.nonce)
    setNullifier(nullifierHex)

    const marketId = marketToBytes32(market)
    const positionId = positionToBytes32(market, side)

    const expectedShares = (stakeMicro * 100_000_000n) / BigInt(price)

    const inputs = {
      merkle_root:    MOCK_ROOT,
      nullifier:      nullifierHex,
      new_commitment: newCommitment,
      bet_amount:     stakeMicro.toString(),
      price:          String(price),
      expected_shares: expectedShares.toString(),
      market_id:      marketId,
      outcome_side:   side === 'YES' ? 1 : 0,
      position_id:    positionId,
    }

    console.log('[bet] submitting to relay:', inputs)

    try {
      setRelayPct(50)
      const { txHash } = await relayBet(MOCK_PROOF, inputs)
      setRelayPct(100)
      setRelayTxHash(txHash)
      console.log('[bet] relay success, txHash:', txHash)

      // Spend old note, save new output note
      markNoteSpent(selectedNote.commitment)
      addNote({
        id: newCommitment,
        kind: 'BET_OUTPUT',
        secret: selectedNote.secret,
        balance: newBalance,
        nonce: newNonce,
        commitment: newCommitment,
        nullifier: computeNullifier(selectedNote.secret, newNonce),
        spent: false,
        createdAt: Date.now(),
        txHash,
        marketId: market,
      })

      setTimeout(() => setStep(3), 600)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[bet] relay failed:', msg)
      setRelayError(msg)
      setRelayPct(0)
    } finally {
      setRelaying(false)
    }
  }

  return (
    <FlowShell
      title="Authorize a bet"
      kicker="BET AUTH · PRIVATE"
      summary={`${side} · ${market.slice(0, 40)}…`}
      steps={steps}
      step={step}
      onBack={() => router.push('/app/markets')}
    >
      {step === 0 && (
        <Step0
          market={market} side={side} price={price}
          stake={stake} setStake={setStake}
          notes={notes} selectedNote={selectedNote} setSelectedNote={setSelectedNote}
          onNext={() => setStep(1)}
        />
      )}
      {step === 1 && <Step1 onNext={handleRelay} />}
      {step === 2 && (
        <Step2 relaying={relaying} txHash={relayTxHash} error={relayError} pct={relayPct} />
      )}
      {step === 3 && (
        <Step3
          market={market} side={side} stake={stake}
          txHash={relayTxHash} nullifier={nullifier}
          onDone={() => router.push('/app/vault')}
        />
      )}
    </FlowShell>
  )
}

export default function BetPage() {
  return (
    <Suspense fallback={<div style={{ padding: 48, textAlign: 'center' }} className="mono">Loading…</div>}>
      <BetPageInner />
    </Suspense>
  )
}
