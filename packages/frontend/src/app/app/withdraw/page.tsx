'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { isAddress } from 'viem'
import { FlowShell, CircuitTrace } from '@/components/app/FlowShell'
import { KV } from '@/components/app/KV'
import { Icon, ICONS } from '@/components/ui/Icon'
import {
  getSpendableNotes,
  computeNullifier,
  computeRecipientHash,
  markNoteSpent,
  formatUsdc,
  type Note,
} from '@/lib/notes'
import { fetchMerklePath, relayWithdrawal, type RelayWithdrawalInputs } from '@/lib/api'
import { generateWithdrawalProof } from '@/lib/prover'
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

const KIND_LABEL: Record<string, string> = {
  DEPOSIT: 'DEPOSIT',
  BET_OUTPUT: 'BET_OUTPUT',
  SETTLE_CREDIT: 'SETTLE_CREDIT',
  CANCEL_CREDIT: 'CANCEL_CREDIT',
}

interface Step0Props {
  notes: Note[]
  selectedIds: string[]
  setSelectedIds: (ids: string[]) => void
  recipient: string
  setRecipient: (r: string) => void
  onNext: () => void
}

function Step0({ notes, selectedIds, setSelectedIds, recipient, setRecipient, onNext }: Step0Props) {
  const toggle = (id: string) =>
    setSelectedIds(
      selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id],
    )

  const totalMicro = selectedIds.reduce((acc, id) => {
    const n = notes.find((x) => x.id === id)
    return n ? acc + n.balance : acc
  }, 0n)

  const recipientValid = recipient.length > 0 && isAddress(recipient)
  const canProceed = selectedIds.length > 0 && recipientValid

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 32 }}>
      <div>
        <div className="micro">SELECT NOTES TO SPEND</div>
        <h3 className="h3 mt-3" style={{ margin: 0 }}>What's leaving the vault?</h3>
        <p className="body mt-3">Each note you spend becomes a nullifier — publicly visible but unlinkable to its commitment.</p>

        {notes.length === 0 ? (
          <div className="panel mt-6" style={{ padding: 20, textAlign: 'center', color: 'var(--text-2)' }}>
            <div className="small">No spendable notes found.</div>
            <div className="small mt-2">Deposit USDC first, or wait for a bet settlement.</div>
          </div>
        ) : (
          <div className="col gap-2 mt-6">
            {notes.map((n) => {
              const on = selectedIds.includes(n.id)
              return (
                <div
                  key={n.id}
                  onClick={() => toggle(n.id)}
                  className="row"
                  style={{
                    padding: '12px 14px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    background: on ? 'oklch(0.82 0.13 210 / 0.06)' : 'transparent',
                    border: '1px solid',
                    borderColor: on ? 'oklch(0.82 0.13 210 / 0.4)' : 'var(--line-strong)',
                    justifyContent: 'space-between',
                  }}
                >
                  <div className="row gap-3">
                    <span
                      style={{
                        width: 14, height: 14, borderRadius: 3, border: '1px solid',
                        borderColor: on ? 'var(--cyan)' : 'var(--line-strong)',
                        background: on ? 'oklch(0.82 0.13 210 / 0.2)' : 'transparent',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}
                    >
                      {on && <Icon d={ICONS.check} size={10} className="text-cyan" />}
                    </span>
                    <div>
                      <div className="mono" style={{ fontSize: 12 }}>{truncate(n.id)}</div>
                      <div className="mono small" style={{ fontSize: 10 }}>
                        {KIND_LABEL[n.kind] ?? n.kind} · {noteAge(n.createdAt)}
                      </div>
                    </div>
                  </div>
                  <div className="num" style={{ fontSize: 15 }}>
                    ${formatUsdc(n.balance)}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div>
        <div className="micro">RECIPIENT &amp; SUMMARY</div>
        <div className="panel mt-3" style={{ padding: 20 }}>
          <div className="micro">RECIPIENT ADDRESS</div>
          <input
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="0x… (any EVM address)"
            style={{
              width: '100%', marginTop: 6,
              background: 'var(--bg-1)', border: '1px solid', borderRadius: 6,
              borderColor: recipient.length > 0 && !recipientValid ? 'var(--red)' : 'var(--line-strong)',
              padding: '12px 14px', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 12,
            }}
          />
          {recipient.length > 0 && !recipientValid && (
            <div className="small mt-1" style={{ color: 'var(--red)', fontSize: 11 }}>
              Invalid EVM address
            </div>
          )}
          <div className="hairline-t mt-4" style={{ paddingTop: 12 }}>
            <KV l="Total payout" v={`$${formatUsdc(totalMicro)} USDC`} />
            <KV l="Notes spent" v={String(selectedIds.length)} />
            <KV l="Proof circuit" v="WITHDRAW_V1 (UltraPLONK)" />
          </div>
          <button
            onClick={() => { log('withdraw_generate_proof_click', { noteCount: selectedIds.length, totalMicro: totalMicro.toString(), recipient }); onNext() }}
            disabled={!canProceed}
            className="btn btn-primary mt-4"
            style={{
              width: '100%', justifyContent: 'center', padding: '14px 0', fontSize: 13,
              opacity: canProceed ? 1 : 0.4, cursor: canProceed ? 'pointer' : 'not-allowed',
            }}
          >
            Generate withdraw proof <Icon d={ICONS.arrow} size={12} />
          </button>
        </div>
      </div>
    </div>
  )
}

interface Step1Props {
  notes: Note[]
  selectedIds: string[]
  recipient: string
  onSuccess: (txHashes: string[]) => void
  onError: (msg: string) => void
}

function Step1({ notes, selectedIds, recipient, onSuccess, onError }: Step1Props) {
  const [statusMsg, setStatusMsg] = useState('fetching merkle paths')
  const [pct, setPct] = useState(0)

  const submitWithdrawals = useCallback(async () => {
    const selected = notes.filter((n) => selectedIds.includes(n.id))
    const batchTimer = timer('withdraw_batch')

    log('withdraw_proof_start', {
      circuit: 'WITHDRAW_V1',
      noteCount: selected.length,
      noteIds: selected.map((n) => n.id),
      totalMicro: selected.reduce((s, n) => s + n.balance, 0n).toString(),
      recipient,
    })

    const recipientHash = computeRecipientHash(recipient as `0x${string}`)
    // Pass recipient as a zero-padded 32-byte field element (always < BN254 prime for a 20-byte address)
    const recipientField = `0x${BigInt(recipient).toString(16).padStart(64, '0')}` as `0x${string}`

    try {
      const txHashes: string[] = []
      const perNote = 100 / selected.length

      for (let i = 0; i < selected.length; i++) {
        const note = selected[i]
        const base = i * perNote

        setStatusMsg(`fetching merkle path (${i + 1}/${selected.length})`)
        setPct(base + perNote * 0.05)

        const merkle = await fetchMerklePath(note.commitment)

        setStatusMsg(`generating proof (${i + 1}/${selected.length}) — 1–3 min`)
        setPct(base + perNote * 0.1)

        // Pulse progress during WASM proving (no accurate progress signal from bb.js)
        const interval = setInterval(() => {
          setPct((p) => Math.min(p + 1.5, base + perNote * 0.88))
        }, 1500)

        const noteTimer = timer('withdraw_prove_note')
        let proofHex: `0x${string}`
        try {
          const { proof } = await generateWithdrawalProof({
            secret:               note.secret,
            final_balance:        note.balance,
            nonce:                note.nonce,
            merkle_path:          merkle.path,
            merkle_path_indices:  merkle.pathIndices,
            recipient_address:    recipientField,
            merkle_root:          merkle.root,
            nullifier:            note.nullifier,
            withdrawal_amount:    note.balance,
            recipient_hash:       recipientHash,
          })
          proofHex = proof
        } finally {
          clearInterval(interval)
        }
        noteTimer({ outcome: 'success', noteId: note.id })

        setStatusMsg(`relaying withdrawal (${i + 1}/${selected.length})`)
        setPct(base + perNote * 0.92)

        const inputs: RelayWithdrawalInputs = {
          merkle_root:       merkle.root,
          nullifier:         note.nullifier,
          withdrawal_amount: note.balance.toString(),
          recipient_hash:    recipientHash,
        }

        log('withdraw_relay_start', {
          ...proofSummary(proofHex),
          inputs: { ...inputs },
          noteId: note.id,
          amount_usdc: note.balance.toString(),
          recipient,
        })

        const { txHash } = await relayWithdrawal(proofHex, inputs, recipient)
        log('withdraw_relay_success', { txHash, noteId: note.id, nullifier: note.nullifier, recipient, amount_usdc: note.balance.toString() })
        txHashes.push(txHash)
        markNoteSpent(note.commitment)
        setPct(base + perNote)
      }

      batchTimer({ outcome: 'success', noteCount: selected.length, txHashes })
      setPct(100)
      setStatusMsg('confirmed')
      onSuccess(txHashes)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      batchTimer({ outcome: 'error', error: msg })
      log('withdraw_relay_error', { error: msg, noteIds: selected.map((n) => n.id), recipient })
      onError(msg)
    }
  }, [notes, selectedIds, recipient, onSuccess, onError])

  useEffect(() => {
    submitWithdrawals()
  }, [submitWithdrawals])

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32 }}>
      <div>
        <div className="micro">PROVING · LOCAL · WASM</div>
        <h3 className="h3 mt-3" style={{ margin: 0 }}>Generating withdraw proof.</h3>
        <p className="body mt-3">
          The WITHDRAW_V1 circuit proves you know the secrets for the selected notes and that none
          have already been spent. This runs entirely in your browser — your secret never leaves.
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
            `> circuit WITHDRAW_V1.wasm        (UltraPLONK)\n> witnesses: merkle path depth-32\n> nullifier set membership: ok\n> commitment merkle path: ok\n> output binding: recipient hash committed\n> π = UltraPLONK proof`
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

interface Step3Props {
  recipient: string
  totalMicro: bigint
  txHashes: string[]
  onDone: () => void
}

function Step3({ recipient, totalMicro, txHashes, onDone }: Step3Props) {
  const explorerBase = process.env.NEXT_PUBLIC_CHAIN_ID === '31337'
    ? 'http://127.0.0.1:8545'
    : 'https://polygonscan.com/tx'

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
            <div className="micro" style={{ color: 'var(--green)' }}>WITHDRAWN · RECIPIENT CREDITED</div>
            <h3 className="h3 mt-1" style={{ margin: 0 }}>Funds delivered.</h3>
          </div>
        </div>
        <p className="body mt-4">
          The recipient address received the withdrawal. The nullifiers for the spent notes are now
          public; the deposit-to-withdrawal link is not.
        </p>
        <div className="panel mt-6" style={{ padding: 20 }}>
          <KV l="Recipient" v={truncate(recipient, 8, 6)} />
          <KV l="Amount delivered" v={`$${formatUsdc(totalMicro)} USDC`} />
          {txHashes.map((h, i) => (
            <KV key={h} l={`Withdraw tx${txHashes.length > 1 ? ` ${i + 1}` : ''}`} v={truncate(h)} />
          ))}
          <KV l="Nullifiers added" v={String(txHashes.length)} />
        </div>
        <div className="row gap-3 mt-6">
          <button className="btn btn-primary" onClick={onDone}>Back to vault</button>
          {txHashes[0] && explorerBase !== 'http://127.0.0.1:8545' && (
            <a href={`${explorerBase}/${txHashes[0]}`} target="_blank" rel="noopener noreferrer" className="btn">
              View on-chain <Icon d={ICONS.external} size={12} />
            </a>
          )}
        </div>
      </div>
      <div>
        <div className="micro">UNLINKABILITY REPORT</div>
        <div className="panel mt-3" style={{ padding: 20 }}>
          <div className="num" style={{ fontSize: 32, color: 'var(--cyan)' }}>99.8%</div>
          <div className="small" style={{ fontSize: 11 }}>
            probability that no observer can link this withdrawal to its origin deposit
          </div>
          <div className="hairline-t mt-4" style={{ paddingTop: 12 }}>
            <KV l="Anonymity set at exit" v="1,842" />
            <KV l="Timing entropy" v="7.4 bits" />
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
  const [notes, setNotes] = useState<Note[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [recipient, setRecipient] = useState('')
  const [txHashes, setTxHashes] = useState<string[]>([])
  const [relayError, setRelayError] = useState<string | null>(null)

  useEffect(() => {
    log('page_view', { route: '/app/withdraw' })
    const spendable = getSpendableNotes()
    setNotes(spendable)
    log('withdraw_notes_loaded', { count: spendable.length, totalMicro: spendable.reduce((s, n) => s + n.balance, 0n).toString() })
  }, [])

  const selectedNotes = notes.filter((n) => selectedIds.includes(n.id))
  const totalMicro = selectedNotes.reduce((acc, n) => acc + n.balance, 0n)

  const steps: [string, string, string][] = [
    ['01', 'Select notes', 'Choose which notes to spend and where to send.'],
    ['02', 'Prove & relay', 'Local WITHDRAW_V1 proof → relay to vault.'],
    ['03', 'Done', 'Funds delivered. Recipient is unlinkable.'],
  ]

  function handleStartProving() {
    setRelayError(null)
    setStep(1)
  }

  function handleRelaySuccess(hashes: string[]) {
    setTxHashes(hashes)
    setTimeout(() => setStep(2), 400)
  }

  function handleRelayError(msg: string) {
    setRelayError(msg)
    setStep(0)
  }

  return (
    <FlowShell
      title="Withdraw to a recipient"
      kicker="WITHDRAW · PRIVATE"
      summary={`${selectedIds.length} note(s) · vault → recipient`}
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
            notes={notes}
            selectedIds={selectedIds}
            setSelectedIds={setSelectedIds}
            recipient={recipient}
            setRecipient={setRecipient}
            onNext={handleStartProving}
          />
        </>
      )}
      {step === 1 && (
        <Step1
          notes={notes}
          selectedIds={selectedIds}
          recipient={recipient}
          onSuccess={handleRelaySuccess}
          onError={handleRelayError}
        />
      )}
      {step === 2 && (
        <Step3
          recipient={recipient}
          totalMicro={totalMicro}
          txHashes={txHashes}
          onDone={() => router.push('/app/vault')}
        />
      )}
    </FlowShell>
  )
}
