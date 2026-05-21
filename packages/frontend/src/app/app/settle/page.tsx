'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { FlowShell, CircuitTrace } from '@/components/app/FlowShell'
import { KV } from '@/components/app/KV'
import { Icon, ICONS } from '@/components/ui/Icon'
import {
  getNotes,
  computeCommitment,
  computeNullifier,
  markNoteSpent,
  addNote,
  formatUsdc,
  marketToField,
  type Note,
} from '@/lib/notes'
import { fetchCurrentMerkleRoot, fetchSettlement, fetchMerklePath, relaySettlement } from '@/lib/api'
import { generateSettlementProof } from '@/lib/prover'
import { log, timer, proofSummary } from '@/lib/logger'

function truncate(hex: string, head = 6, tail = 4): string {
  if (hex.length <= head + tail + 2) return hex
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`
}

function noteAge(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000)
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

interface Step0Props {
  betNotes: Note[]
  selected: number
  setSelected: (i: number) => void
  onNext: () => void
}

function Step0({ betNotes, selected, setSelected, onNext }: Step0Props) {
  if (betNotes.length === 0) {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 32 }}>
        <div>
          <div className="micro">CLAIMABLE SETTLEMENTS</div>
          <h3 className="h3 mt-3" style={{ margin: 0 }}>No active positions.</h3>
          <p className="body mt-3">
            You have no unspent BET_OUTPUT notes. Place a bet first and wait for the signing layer
            to report it as filled on-chain.
          </p>
          <div className="panel mt-6" style={{ padding: 20, color: 'var(--text-2)', fontSize: 12 }}>
            The signing layer calls <code>Vault.reportFilled()</code> after your FOK order is
            matched on Polymarket. Check the backend logs for confirmation.
          </div>
        </div>
        <div />
      </div>
    )
  }

  const note = betNotes[selected]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 32 }}>
      <div>
        <div className="micro">CLAIMABLE SETTLEMENTS</div>
        <h3 className="h3 mt-3" style={{ margin: 0 }}>Pick a resolved position.</h3>
        <p className="body mt-3">
          Each market resolves on-chain. Your share of the payout becomes a fresh private note —
          unlinkable to the original bet authorization.
        </p>
        <div className="col mt-6 gap-2">
          {betNotes.map((n, i) => (
            <div
              key={n.id}
              onClick={() => setSelected(i)}
              className="row"
              style={{
                padding: '14px 16px', borderRadius: 6, cursor: 'pointer',
                background: i === selected ? 'oklch(0.82 0.13 210 / 0.06)' : 'transparent',
                border: '1px solid',
                borderColor: i === selected ? 'oklch(0.82 0.13 210 / 0.4)' : 'var(--line-strong)',
                justifyContent: 'space-between',
              }}
            >
              <div className="row gap-3">
                <span
                  style={{
                    width: 14, height: 14, borderRadius: '50%', border: '1px solid',
                    borderColor: i === selected ? 'var(--cyan)' : 'var(--line-strong)',
                    background: i === selected ? 'var(--cyan)' : 'transparent',
                  }}
                />
                <div>
                  <div style={{ fontSize: 13 }}>
                    {n.marketId ? n.marketId.slice(0, 40) : truncate(n.id)}
                  </div>
                  <div className="mono small" style={{ fontSize: 11 }}>
                    balance ${formatUsdc(n.balance)} · BET_OUTPUT · {noteAge(n.createdAt)}
                  </div>
                </div>
              </div>
              <div className="num" style={{ fontSize: 16, color: 'var(--green)' }}>
                +${formatUsdc(n.balance)}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="micro">SUMMARY</div>
        <div className="panel mt-3" style={{ padding: 20 }}>
          <KV l="Market" v={note.marketId ? note.marketId.slice(0, 30) : truncate(note.id)} />
          <KV l="Note balance" v={`$${formatUsdc(note.balance)} USDC`} />
          <KV l="Shares held" v={note.expectedShares ? note.expectedShares.toString() : '—'} />
          <KV l="Credit form" v="private note" />
          <KV l="Circuit" v="SETTLE_CRED (UltraPLONK)" />
          <button
            className="btn btn-primary mt-4"
            style={{ width: '100%', justifyContent: 'center', padding: '14px 0', fontSize: 13 }}
            onClick={() => { log('settle_generate_proof_click', { noteId: note.id, marketId: note.marketId, balance: note.balance.toString(), expectedShares: note.expectedShares?.toString() }); onNext() }}
          >
            Generate settlement proof <Icon d={ICONS.arrow} size={12} />
          </button>
        </div>
      </div>
    </div>
  )
}

interface Step1Props {
  note: Note
  onSuccess: (newNote: Note, txHash: string) => void
  onError: (msg: string) => void
}

function Step1({ note, onSuccess, onError }: Step1Props) {
  const [statusMsg, setStatusMsg] = useState('fetching settlement record')
  const [pct, setPct] = useState(0)

  const submitSettlement = useCallback(async () => {
    const relayTimer = timer('settle_relay')
    log('settle_proof_start', { circuit: 'SETTLE_CRED', noteId: note.id, marketId: note.marketId, balance: note.balance.toString() })

    try {
      // 1. Fetch settlement record to get payout_per_share.
      //    The indexer keys records by the bytes32 conditionId (= marketToField(label)),
      //    which is the same field element the circuit uses for market_id.
      setStatusMsg('fetching settlement record')
      setPct(3)
      const marketIdField = note.marketId
        ? marketToField(note.marketId)
        : (`0x${'00'.repeat(32)}` as `0x${string}`)
      const settlementRecord = note.marketId
        ? await fetchSettlement(marketIdField)
        : null

      if (!settlementRecord) {
        throw new Error(
          note.marketId
            ? `Market "${note.marketId}" has not resolved yet. Check back after the outcome is published.`
            : 'Note has no marketId — cannot look up settlement record.'
        )
      }

      const payoutPerShare = BigInt(Math.round(settlementRecord.payout_per_share))
      const sharesHeld = note.expectedShares ?? 0n
      const totalCredit = sharesHeld * payoutPerShare

      // 2. Fetch merkle path (provides root + path + indices)
      setStatusMsg('fetching merkle path')
      setPct(8)
      const merkle = await fetchMerklePath(note.commitment)

      // 3. Compute new note after credit
      const newNonce = note.nonce + 1n
      const newBalance = note.balance + totalCredit
      const newCommitment = computeCommitment(note.secret, newBalance, newNonce)
      const newNullifier = computeNullifier(note.secret, newNonce)

      // nullifier_of_bet = nullifier of the note spent in bet_auth (nonce - 1)
      const nullifierOfBet = computeNullifier(note.secret, note.nonce - 1n)
      // marketIdField already computed above (also used for fetchSettlement lookup)

      // 4. Generate real UltraPLONK proof
      setStatusMsg('generating proof — 1–3 min')
      setPct(12)

      const interval = setInterval(() => {
        setPct((p) => Math.min(p + 1.5, 88))
      }, 1500)

      let proofHex: `0x${string}`
      try {
        const { proof } = await generateSettlementProof({
          secret:                note.secret,
          balance_before_credit: note.balance,
          nonce:                 note.nonce,
          merkle_path:           merkle.path,
          merkle_path_indices:   merkle.pathIndices,
          merkle_root:           merkle.root,
          nullifier:             note.nullifier,
          new_commitment:        newCommitment,
          nullifier_of_bet:      nullifierOfBet,
          market_id:             marketIdField,
          payout_per_share:      payoutPerShare,
          shares_held:           sharesHeld,
          total_credit:          totalCredit,
        })
        proofHex = proof
      } finally {
        clearInterval(interval)
      }

      setStatusMsg('relaying settlement proof')
      setPct(92)

      const inputs = {
        merkle_root:      merkle.root,
        nullifier:        note.nullifier,
        new_commitment:   newCommitment,
        nullifier_of_bet: nullifierOfBet,
        market_id:        marketIdField,
        payout_per_share: payoutPerShare.toString(),
        total_credit:     totalCredit.toString(),
      }

      log('settle_relay_start', {
        ...proofSummary(proofHex),
        inputs: { ...inputs },
        noteId: note.id,
        marketId: note.marketId,
        sharesHeld: sharesHeld.toString(),
      })

      const { txHash } = await relaySettlement(proofHex, inputs)
      relayTimer({ outcome: 'success', txHash, marketId: note.marketId })
      log('settle_relay_success', { txHash, marketId: note.marketId, nullifier: note.nullifier, new_commitment: newCommitment })

      markNoteSpent(note.commitment)
      const creditNote: Note = {
        id: newCommitment,
        kind: 'SETTLE_CREDIT',
        secret: note.secret,
        balance: newBalance,
        nonce: newNonce,
        commitment: newCommitment,
        nullifier: newNullifier,
        spent: false,
        createdAt: Date.now(),
        txHash,
        marketId: note.marketId,
      }
      addNote(creditNote)
      log('note_created', { kind: 'SETTLE_CREDIT', commitment: newCommitment, balance: newBalance.toString(), marketId: note.marketId })

      setPct(100)
      setStatusMsg('confirmed')
      onSuccess(creditNote, txHash)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      relayTimer({ outcome: 'error', error: msg })
      log('settle_relay_error', { error: msg, noteId: note.id, marketId: note.marketId })
      onError(msg)
    }
  }, [note, onSuccess, onError])

  useEffect(() => {
    submitSettlement()
  }, [submitSettlement])

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32 }}>
      <div>
        <div className="micro">PROVING · LOCAL · WASM</div>
        <h3 className="h3 mt-3" style={{ margin: 0 }}>Generating settlement proof.</h3>
        <p className="body mt-3">
          SETTLE_CRED proves you held a winning position in the resolved market without revealing
          which note authorized the original bet. Runs entirely in your browser.
        </p>
        <div className="panel mt-6" style={{ padding: 20 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="mono" style={{ fontSize: 12, color: 'var(--cyan)' }}>{statusMsg}</span>
            <span className="mono" style={{ fontSize: 12 }}>{Math.round(pct)}%</span>
          </div>
          <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, marginTop: 8 }}>
            <div style={{ height: 4, width: `${pct}%`, background: 'var(--cyan)', borderRadius: 2, transition: 'width 0.6s ease' }} />
          </div>
          <pre className="mono mt-4" style={{ margin: 0, fontSize: 10, color: 'var(--text-2)', lineHeight: 1.6 }}>{
            `> circuit SETTLE_CRED.wasm       (UltraPLONK)\n> nullifier_of_bet bound\n> claim merkle path: ok\n> share count attested\n> credit note committed\n> π = UltraPLONK proof`
          }</pre>
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

interface Step2Props {
  creditNote: Note
  txHash: string
  onDone: () => void
}

function Step2({ creditNote, txHash, onDone }: Step2Props) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 32 }}>
      <div>
        <div className="row gap-3">
          <div
            style={{
              width: 40, height: 40, borderRadius: 8,
              background: 'oklch(0.78 0.16 152 / 0.18)', color: 'var(--green)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Icon d={ICONS.check} size={20} />
          </div>
          <div>
            <div className="micro" style={{ color: 'var(--green)' }}>CREDITED · NEW NOTE ADDED</div>
            <h3 className="h3 mt-1" style={{ margin: 0 }}>Settlement claimed.</h3>
          </div>
        </div>
        <p className="body mt-4">
          The credit is live in your vault as a fresh private note. You can now withdraw it or
          use it for another bet.
        </p>
        <div className="panel mt-6" style={{ padding: 20 }}>
          <KV l="New note ID" v={truncate(creditNote.id)} />
          <KV l="Note balance" v={`$${formatUsdc(creditNote.balance)} USDC`} />
          <KV l="Settlement tx" v={truncate(txHash)} />
          <KV l="Circuit" v="SETTLE_CRED" />
          <KV l="Note state" v="OPEN · spendable" />
        </div>
        <div className="row gap-3 mt-6">
          <button className="btn btn-primary" onClick={onDone}>Back to vault</button>
          <button className="btn" onClick={() => (window.location.href = '/app/withdraw')}>
            Withdraw to wallet
          </button>
        </div>
      </div>
      <div>
        <div className="panel" style={{ padding: 20 }}>
          <div className="micro">WHAT JUST HAPPENED</div>
          <div className="col mt-3 gap-3">
            {[
              ['Bet record looked up', 'Vault confirmed the bet was filled on-chain.'],
              ['Settlement proof verified', 'The circuit proved your note authorized the original bet.'],
              ['New private note minted', 'Credit lands in your vault, unlinkable to the original bet.'],
            ].map(([t, s], i) => (
              <div key={i} className="row gap-3">
                <span className="mono" style={{ fontSize: 11, color: 'var(--cyan)', minWidth: 22 }}>
                  0{i + 1}
                </span>
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
  const [betNotes, setBetNotes] = useState<Note[]>([])
  const [selected, setSelected] = useState(0)
  const [creditNote, setCreditNote] = useState<Note | null>(null)
  const [txHash, setTxHash] = useState('')
  const [relayError, setRelayError] = useState<string | null>(null)

  useEffect(() => {
    log('page_view', { route: '/app/settle' })
    const all = getNotes()
    const bets = all.filter((n) => !n.spent && n.kind === 'BET_OUTPUT')
    setBetNotes(bets)
    log('settle_notes_loaded', { count: bets.length, noteIds: bets.map((n) => n.id) })
  }, [])

  const steps: [string, string, string][] = [
    ['01', 'Select claim', 'Pick a resolved position to credit.'],
    ['02', 'Prove settlement', 'Local SETTLE_CRED proof → relay to vault.'],
    ['03', 'Done', 'Credit note added to vault.'],
  ]

  function handleStartProving() {
    setRelayError(null)
    setStep(1)
  }

  function handleRelaySuccess(note: Note, hash: string) {
    setCreditNote(note)
    setTxHash(hash)
    setTimeout(() => setStep(2), 400)
  }

  function handleRelayError(msg: string) {
    setRelayError(msg)
    setStep(0)
  }

  return (
    <FlowShell
      title="Claim settlement credit"
      kicker="SETTLE · PRIVATE"
      summary="Credit goes to a new private note"
      steps={steps}
      step={step}
      onBack={() => router.push('/app/vault')}
    >
      {step === 0 && (
        <>
          {relayError && (
            <div
              className="panel mb-4"
              style={{ padding: '12px 16px', borderColor: 'var(--red)', color: 'var(--red)', fontSize: 12 }}
            >
              Relay error: {relayError}
            </div>
          )}
          <Step0
            betNotes={betNotes}
            selected={selected}
            setSelected={setSelected}
            onNext={handleStartProving}
          />
        </>
      )}
      {step === 1 && betNotes[selected] && (
        <Step1
          note={betNotes[selected]}
          onSuccess={handleRelaySuccess}
          onError={handleRelayError}
        />
      )}
      {step === 2 && creditNote && (
        <Step2
          creditNote={creditNote}
          txHash={txHash}
          onDone={() => router.push('/app/vault')}
        />
      )}
    </FlowShell>
  )
}
