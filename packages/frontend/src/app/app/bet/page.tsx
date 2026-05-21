'use client'
import { Suspense, useState, useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { parseUnits } from 'viem'
import { FlowShell, CircuitTrace } from '@/components/app/FlowShell'
import { KV } from '@/components/app/KV'
import { Icon, ICONS } from '@/components/ui/Icon'
import {
  getNotes, computeCommitment, computeNullifier,
  marketToField, positionToField, markNoteSpent, addNote, formatUsdc, type Note,
} from '@/lib/notes'
import { relayBet, fetchCurrentMerkleRoot, fetchMerklePath } from '@/lib/api'
import { generateBetAuthProof, type ProofResult } from '@/lib/prover'
import { log, timer, proofSummary } from '@/lib/logger'

function short(hex: string) { return hex.slice(0, 8) + '…' + hex.slice(-6) }

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
          <button
            className="btn btn-primary mt-4"
            style={{ width: '100%', justifyContent: 'center', padding: '14px 0', fontSize: 13, opacity: canNext ? 1 : 0.4 }}
            onClick={canNext ? () => { log('bet_generate_proof_click', { market, side, stake, price, noteId: selectedNote?.id, noteBalance: selectedNote?.balance?.toString() }); onNext() } : undefined}
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

// ── Step 1: WASM proving ──────────────────────────────────────────────────────

function Step1({ pct, error }: { pct: number; error: string | null }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32 }}>
      <div>
        <div className="micro">PROVING · LOCAL · WASM</div>
        <h3 className="h3 mt-3" style={{ margin: 0 }}>Generating bet authorization proof.</h3>
        <p className="body mt-3">BET_AUTH proves your note&apos;s balance covers the stake and nullifies it — without revealing which wallet deposited.</p>
        <p className="body mt-2" style={{ fontSize: 12, color: 'var(--text-2)' }}>Barretenberg WASM proof generation takes 1–3 minutes. Do not navigate away.</p>
        {error && (
          <div className="panel mt-3" style={{ padding: 14, borderColor: 'var(--red)', background: 'oklch(0.70 0.18 25 / 0.06)' }}>
            <div className="small" style={{ color: 'var(--red)', fontSize: 12 }}>Proof error: {error}</div>
          </div>
        )}
        <div className="panel mt-4" style={{ padding: 20 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="mono" style={{ fontSize: 12, color: 'var(--cyan)' }}>{pct < 100 ? 'composing proof…' : 'proof ready'}</span>
            <span className="mono" style={{ fontSize: 12 }}>{pct}%</span>
          </div>
          <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, marginTop: 8 }}>
            <div style={{ height: 4, width: `${pct}%`, background: 'var(--cyan)', borderRadius: 2, transition: 'width 1.2s linear' }} />
          </div>
          <pre className="mono mt-4" style={{ margin: 0, fontSize: 10, color: 'var(--text-2)', lineHeight: 1.6 }}>{`> circuit BET_AUTH\n> witnesses: balance ≥ stake ✓\n> nullifier = Poseidon(secret, nonce)\n> new_commitment = Poseidon(secret, bal', nonce')\n> shares arithmetic verified ✓\n> π = UltraPLONK proof`}</pre>
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

  // Proof generation state (step 1)
  const [provePct, setProvePct] = useState(0)
  const [proveError, setProveError] = useState<string | null>(null)

  // Relay state (step 2)
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

  useEffect(() => {
    log('page_view', { route: '/app/bet', market, side, price })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Called by Step0 "Generate bet proof" button
  async function handleStartProve() {
    if (!selectedNote) return
    setStep(1)
    setProvePct(5)
    setProveError(null)

    const proveTimer = timer('bet_proof_generate')

    // Pulse progress bar during long WASM computation
    const pulse = setInterval(() => {
      setProvePct((p) => (p < 88 ? p + 1 : p))
    }, 1500)

    try {
      const stakeMicro = parseUnits(String(stake), 6)
      const newBalance = selectedNote.balance - stakeMicro
      const newNonce = selectedNote.nonce + 1n
      const newCommitment = computeCommitment(selectedNote.secret, newBalance, newNonce)
      const nullifierHex = computeNullifier(selectedNote.secret, selectedNote.nonce)
      setNullifier(nullifierHex)

      const marketId = marketToField(market)
      const positionId = positionToField(market, side)
      const expectedShares = (stakeMicro * 100_000_000n) / BigInt(price)
      const shareRemainder = (stakeMicro * 100_000_000n) % BigInt(price)

      const vaultAddr = process.env.NEXT_PUBLIC_VAULT_ADDRESS ?? ''
      const [merkleProof] = await Promise.all([
        fetchMerklePath(selectedNote.commitment),
      ])
      const merkleRoot = merkleProof.root as `0x${string}`

      log('bet_proof_start', { circuit: 'BET_AUTH', nullifier: nullifierHex })

      const proofResult = await generateBetAuthProof({
        secret:              selectedNote.secret,
        current_balance:     selectedNote.balance,
        nonce:               selectedNote.nonce,
        merkle_path:         merkleProof.path,
        merkle_path_indices: merkleProof.pathIndices,
        share_remainder:     shareRemainder,
        merkle_root:         merkleRoot,
        nullifier:           nullifierHex,
        new_commitment:      newCommitment,
        bet_amount:          stakeMicro,
        price:               BigInt(price),
        expected_shares:     expectedShares,
        market_id:           marketId,
        outcome_side:        side === 'YES' ? 1 : 0,
        position_id:         positionId,
      })

      clearInterval(pulse)
      setProvePct(100)
      proveTimer({ circuit: 'BET_AUTH', outcome: 'success', ...proofSummary(proofResult.proof) })
      log('bet_proof_done', { nullifier: nullifierHex, proof_bytes: proofResult.proof.length })

      // Brief pause so user sees 100%, then relay
      await new Promise((r) => setTimeout(r, 600))
      await handleRelay(proofResult, {
        nullifierHex, newCommitment, newBalance, newNonce,
        stakeMicro, expectedShares, marketId, positionId, merkleRoot,
      })
    } catch (err) {
      clearInterval(pulse)
      const msg = err instanceof Error ? err.message : String(err)
      setProveError(msg)
      log('bet_proof_error', { error: msg })
    }
  }

  async function handleRelay(
    proofResult: ProofResult,
    inputs: {
      nullifierHex: `0x${string}`
      newCommitment: `0x${string}`
      newBalance: bigint
      newNonce: bigint
      stakeMicro: bigint
      expectedShares: bigint
      marketId: string
      positionId: string
      merkleRoot: `0x${string}`
    },
  ) {
    setStep(2)
    setRelaying(true)
    setRelayPct(20)
    setRelayError(null)

    const relayTimer = timer('bet_relay')

    const relayInputs = {
      merkle_root:     inputs.merkleRoot,
      nullifier:       inputs.nullifierHex,
      new_commitment:  inputs.newCommitment,
      bet_amount:      inputs.stakeMicro.toString(),
      price:           String(price),
      expected_shares: inputs.expectedShares.toString(),
      market_id:       inputs.marketId,
      outcome_side:    side === 'YES' ? 1 : 0,
      position_id:     inputs.positionId,
    }

    log('bet_relay_start', {
      ...proofSummary(proofResult.proof),
      inputs: { ...relayInputs },
      market, side, stake_usdc: stake,
    })

    try {
      setRelayPct(50)
      const { txHash } = await relayBet(proofResult.proof, relayInputs)
      setRelayPct(100)
      setRelayTxHash(txHash)
      relayTimer({ outcome: 'success', txHash, market, side, stake_usdc: stake })
      log('bet_relay_success', { txHash, market, side, stake_usdc: stake, nullifier: inputs.nullifierHex })

      markNoteSpent(selectedNote!.commitment)
      addNote({
        id: inputs.newCommitment,
        kind: 'BET_OUTPUT',
        secret: selectedNote!.secret,
        balance: inputs.newBalance,
        nonce: inputs.newNonce,
        commitment: inputs.newCommitment,
        nullifier: computeNullifier(selectedNote!.secret, inputs.newNonce),
        spent: false,
        createdAt: Date.now(),
        txHash,
        marketId: market,
        expectedShares: inputs.expectedShares,
      })
      log('note_created', { kind: 'BET_OUTPUT', commitment: inputs.newCommitment, balance: inputs.newBalance.toString() })

      setTimeout(() => setStep(3), 600)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      relayTimer({ outcome: 'error', error: msg })
      log('bet_relay_error', { error: msg, market, side, stake_usdc: stake })
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
          onNext={handleStartProve}
        />
      )}
      {step === 1 && <Step1 pct={provePct} error={proveError} />}
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
