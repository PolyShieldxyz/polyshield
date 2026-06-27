'use client'
import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContract, useSignMessage, usePublicClient } from 'wagmi'
import { parseUnits } from 'viem'
import { FlowShell } from '@/components/app/FlowShell'
import { KV } from '@/components/app/KV'
import { LiveRegion } from '@/components/app/LiveRegion'
import { Icon, ICONS } from '@/components/ui/Icon'
import { AmountInput } from '@/components/ui/AmountInput'
import { VAULT_ABI, USDC_ABI } from '@/lib/vaultAbi'
import {
  computeCommitment, computeNullifier,
  getSafeNextDepositIndex, recordDepositIndexUsed, addNote, recordWalletActivity,
} from '@/lib/notes'
import { getNoteSecret } from '@/lib/secretSession'
import { fetchSpentNullifiers } from '@/lib/api'
import { generateProofInWorker } from '@/lib/prover'
import { classifyTxError } from '@/lib/txError'
import { setMoneyOpInFlight, clearMoneyOpInFlight } from '@/lib/inFlightGuard'
import { markDepositSubmitted, clearDepositMarker, getDepositMarkers } from '@/lib/depositMarker'
import Link from 'next/link'

const IS_DEV = process.env.NEXT_PUBLIC_DEV_MODE === 'true'
const VAULT_ADDRESS = (process.env.NEXT_PUBLIC_VAULT_ADDRESS ?? '0x0000000000000000000000000000000000000000') as `0x${string}`
const USDC_ADDRESS  = (process.env.NEXT_PUBLIC_USDC_ADDRESS  ?? '0x0000000000000000000000000000000000000000') as `0x${string}`

function short(hex: string) { return hex.slice(0, 8) + '…' + hex.slice(-6) }

// Minimum deposit enforced in the UI ($1 USDC). Keeps dust deposits out of the pool and
// matches the protocol's minimums elsewhere (minBet $1; minWithdrawal $5).
const MIN_DEPOSIT = 1

// Per-address cumulative deposit cap (MVP): $50,000 USDC, enforced on-chain in deposit() via
// cumulativeDeposits[msg.sender]. Surfaced here so the user never spends a signature + 30s–2min
// proof + approve gas only to hit an opaque on-chain revert. Keep in sync with the contract.
const DEPOSIT_CAP_MICRO = 50_000_000_000n // 50,000 * 1e6

// ── Visual components ────────────────────────────────────────────────────────

function MerkleInsertionVisual({ pct }: { pct: number }) {
  return (
    <svg viewBox="0 0 320 200" width="100%">
      {([[[160,20]], [[80,60],[240,60]], [[40,100],[120,100],[200,100],[280,100]], [[20,140],[60,140],[100,140],[140,140],[180,140],[220,140],[260,140],[300,140]]] as number[][][]).map((level, li) =>
        level.map(([x, y], i) => (
          <g key={`${li}-${i}`}>
            {li > 0 && (() => {
              const parents = ([[[160,20]], [[80,60],[240,60]], [[40,100],[120,100],[200,100],[280,100]]] as number[][][])[li-1]
              const [px, py] = parents[Math.floor(i/2)]
              return <line x1={px} y1={py+6} x2={x} y2={y-6} stroke="rgba(255,255,255,0.12)" />
            })()}
            <circle cx={x} cy={y} r={li===0?6:li===1?5:4} fill={li===0?'var(--cyan)':'rgba(255,255,255,0.4)'} />
          </g>
        ))
      )}
      {[0,1,2,3,4,5,6,7].map((i) => {
        const x = 20 + i * 40
        const isNew = i === 6
        const opacity = isNew ? pct / 100 : 1
        const color = isNew ? 'oklch(0.85 0.13 85)' : i < 5 ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.2)'
        return (
          <g key={i}>
            {isNew && pct < 100 && <circle cx={x} cy={140} r={8} fill="oklch(0.82 0.13 85 / 0.2)" />}
            <circle cx={x} cy={140} r="5" fill={color} opacity={opacity} />
            {isNew && <text x={x} y={170} textAnchor="middle" fontFamily="JetBrains Mono" fontSize="9" fill="var(--accent)">NEW</text>}
          </g>
        )
      })}
      <text x="160" y="194" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="9" fill="rgba(255,255,255,0.4)">depth-32 Poseidon Merkle tree</text>
    </svg>
  )
}

// ── Step 0: choose amount ────────────────────────────────────────────────────

function Step0({
  amount, setAmount, onNext, deriving,
  usdcBalance, mintUsdc, minting, remainingCap,
  balanceResolved, capResolved,
}: {
  amount: number
  setAmount: (v: number) => void
  onNext: () => void
  deriving: boolean
  usdcBalance: bigint
  mintUsdc: () => void
  minting: boolean
  // Dollars remaining under the $50k per-address cumulative cap (50,000 minus prior deposits).
  remainingCap: number
  // Have the on-chain reads resolved? Until then we must NOT present defaulted 0n as real money.
  balanceResolved: boolean
  capResolved: boolean
}) {
  const balanceFormatted = (Number(usdcBalance) / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  // Don't flag "insufficient" against a balance we haven't actually read yet (defaulted 0n).
  const insufficient = balanceResolved && usdcBalance < parseUnits(String(amount), 6)
  const belowMin = amount > 0 && amount < MIN_DEPOSIT
  // T20/cap: block before the signature+proof+gas instead of letting deposit() revert on-chain.
  const capReached = remainingCap <= 0
  const overCap = amount > 0 && amount > remainingCap + 1e-9

  return (
    <div className="m-grid" style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 32 }}>
      <div>
        <div className="micro">DEPOSIT AMOUNT</div>
        {/* COPY-001: distinct from the FlowShell "Deposit USDC" title — a prompt, not a repeat. */}
        <h3 className="h3 mt-3" style={{ margin: 0 }}>How much would you like to deposit?</h3>
        <p className="body mt-3">Funds enter the shared anonymity pool. They are not linkable to any future bets you authorize from them.</p>
        <div className="mt-6">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="micro">AMOUNT</div>
            <div className="row gap-3" style={{ alignItems: 'center' }}>
              {/* Wallet USDC.e balance (the collateral token the vault accepts). Always shown so the
                  user can see what they have to deposit; the mint button is a dev-only convenience. */}
              <button
                type="button"
                className="small"
                style={{ fontSize: 11, color: 'var(--text-3)', background: 'none', border: 'none', cursor: balanceResolved ? 'pointer' : 'default', padding: 0 }}
                onClick={() => { if (balanceResolved) setAmount(Math.floor(Number(usdcBalance) / 1e6)) }}
                disabled={!balanceResolved}
                title="Use full wallet balance"
              >
                {/* Loading vs real $0: never render a defaulted 0n as a real "$0.00". */}
                Wallet: {balanceResolved ? `$${balanceFormatted}` : '—'} USDC.e
              </button>
              {IS_DEV && (
                <button className="btn btn-sm" style={{ fontSize: 10, padding: '3px 8px' }} onClick={mintUsdc} disabled={minting}>
                  {minting ? 'Minting…' : '+ Get test USDC'}
                </button>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg-1)', border: `1px solid ${insufficient && amount > 0 ? 'var(--red)' : 'var(--line-strong)'}`, borderRadius: 6, padding: '0 14px', marginTop: 8 }}>
            <span className="mono" style={{ color: 'var(--text-2)', marginRight: 8, fontSize: 20 }}>$</span>
            {/* String-backed money input (see AmountInput) — a controlled type=number dropped digits. */}
            <AmountInput value={amount} onValueChange={(n) => setAmount(Math.max(0, n))}
              ariaLabel="Deposit amount in USDC"
              style={{ fontSize: 28, padding: '16px 0' }} />
            <span className="mono" style={{ color: 'var(--text-2)', fontSize: 14, letterSpacing: '0.06em' }}>USDC</span>
          </div>
          {belowMin && (
            <div className="small mt-1" style={{ fontSize: 11, color: 'var(--red)' }}>Minimum deposit is ${MIN_DEPOSIT} USDC.</div>
          )}
          {insufficient && amount > 0 && (
            <div className="small mt-1" style={{ fontSize: 11, color: 'var(--red)' }}>Insufficient USDC balance{IS_DEV && ' — click "+ Get test USDC" above'}</div>
          )}
          {/* Cap: surface the remaining capacity BEFORE the user proves/pays, never via a revert. */}
          {!capResolved ? (
            <div className="small mt-1" style={{ fontSize: 11, color: 'var(--text-3)' }}>
              Remaining deposit capacity: — of $50,000
            </div>
          ) : capReached ? (
            <div className="small mt-1" style={{ fontSize: 11, color: 'var(--red)' }}>
              You&apos;ve reached the $50,000 per-address deposit cap. Withdraw before depositing more.
            </div>
          ) : overCap ? (
            <div className="small mt-1" style={{ fontSize: 11, color: 'var(--red)' }}>
              Exceeds your remaining ${remainingCap.toLocaleString()} deposit capacity (max $50,000 per address).
            </div>
          ) : (
            <div className="small mt-1" style={{ fontSize: 11, color: 'var(--text-3)' }}>
              Remaining deposit capacity: ${remainingCap.toLocaleString()} of $50,000
            </div>
          )}
          <div className="row mt-2 gap-2">
            {[5000, 10000, 25000, 50000].map((v) => {
              const disabled = capResolved && v > remainingCap
              return (
                <button
                  key={v}
                  onClick={() => setAmount(v)}
                  disabled={disabled}
                  title={disabled ? `Above your remaining $${remainingCap.toLocaleString()} capacity` : undefined}
                  className={`btn btn-sm ${amount === v ? 'btn-cyan' : 'btn-ghost'}`}
                  style={{ flex: 1, justifyContent: 'center', padding: '6px 0', fontSize: 11, opacity: disabled ? 0.4 : 1 }}
                >
                  ${v >= 1000 ? `${v / 1000}k` : v}
                </button>
              )
            })}
          </div>
        </div>
      </div>
      <div>
        <div className="micro">SUMMARY</div>
        <div className="panel mt-3" style={{ padding: 20 }}>
          <KV l="Amount" v={`$${amount.toLocaleString()} USDC`} />
          <KV l="Remaining cap" v={capResolved ? `$${remainingCap.toLocaleString()} of $50,000` : '— of $50,000'} />
          <KV l="Vault" v={VAULT_ADDRESS ? short(VAULT_ADDRESS) : '(not connected)'} />
          <KV l="Network fee" v="~$0.04 (Polygon)" />
          <KV l="PolyShield fee" v="$0.00" />
          <KV l="Key derivation" v="Poseidon4(wallet_sig_hash, …)" />
          {IS_DEV && <KV l="Mode" v="DEV — MockVerifier" />}
          <button
            className="btn btn-primary mt-4"
            style={{ width: '100%', justifyContent: 'center', padding: '14px 0', fontSize: 13 }}
            onClick={onNext}
            disabled={amount < MIN_DEPOSIT || insufficient || deriving || overCap || capReached || !balanceResolved}
          >
            {deriving ? 'Signing…' : <>Sign to derive key <Icon d={ICONS.arrow} size={12} /></>}
          </button>
          <div className="small mt-2" style={{ textAlign: 'center', color: 'var(--text-3)', fontSize: 11 }}>Key derived from wallet signature · never stored</div>
        </div>
      </div>
    </div>
  )
}

// ── Step 1: approve + deposit transactions ───────────────────────────────────

type TxPhase = 'prove' | 'approve' | 'wait-approve' | 'deposit' | 'wait-deposit' | 'done'

function Step1({
  amount, commitment, onDone,
  phase, setPhase, approveTx, depositTx, txError,
  doApprove, doDeposit, doProve, proofPct, provingPhase,
}: {
  amount: number
  commitment: string
  onDone: (txHash: string) => void
  phase: TxPhase
  setPhase: (p: TxPhase) => void
  approveTx: string | undefined
  depositTx: string | undefined
  txError: ReturnType<typeof classifyTxError> | null
  doApprove: () => void | Promise<void>
  doDeposit: () => void | Promise<void>
  doProve: () => void | Promise<void>
  proofPct: number
  provingPhase: 'download' | 'prove' | null
}) {
  // The ZK deposit-binding proof (FC-2) is generated client-side and can take a while — especially the
  // first time, when the proving key still has to download. It is the FIRST tracked step: the deposit
  // transaction carries the proof, so nothing on-chain can happen until it's in hand.
  const checks: [string, TxPhase[]][] = [
    ['Deposit proof generated',    ['approve', 'wait-approve', 'deposit', 'wait-deposit', 'done']],
    ['USDC spend approved',        ['wait-approve', 'deposit', 'wait-deposit', 'done']],
    ['Deposit transaction signed', ['wait-deposit', 'done']],
    ['Broadcast to RPC',           ['wait-deposit', 'done']],
    ['Included in block',          ['done']],
    ['Merkle leaf appended',       ['done']],
  ]

  // On-chain progress (drives the Merkle visual). The proof phase is pre-chain, so it reads 0 here.
  const txPct = ({ prove: 0, approve: 0, 'wait-approve': 20, deposit: 40, 'wait-deposit': 65, done: 100 } as Record<TxPhase, number>)[phase]
  const inProof = phase === 'prove'
  // During proof generation the bar shows the proof-work %; afterwards it tracks the on-chain submit.
  const barPct = inProof ? proofPct : txPct
  const statusLabel = inProof
    ? (provingPhase === 'prove' ? 'generating proof…' : 'downloading proving key…')
    : phase === 'approve' ? 'waiting for approval…'
    : phase === 'wait-approve' ? 'confirming approval…'
    : phase === 'deposit' ? 'submitting deposit…'
    : phase === 'wait-deposit' ? 'confirming deposit…'
    : 'complete'

  useEffect(() => {
    if (phase === 'prove') void doProve()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  useEffect(() => {
    if (phase === 'deposit') void doDeposit()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  useEffect(() => {
    if (phase === 'done' && depositTx) onDone(depositTx)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, depositTx])

  return (
    <div className="m-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32 }}>
      <div>
        <div className="micro">{inProof ? 'ZERO-KNOWLEDGE PROOF · IN BROWSER' : 'VAULT SUBMIT · ON-CHAIN'}</div>
        <h3 className="h3 mt-3" style={{ margin: 0 }}>{inProof ? 'Generating your deposit proof.' : 'Submitting deposit on-chain.'}</h3>
        <p className="body mt-3">{inProof
          ? 'A zero-knowledge proof binds your hidden balance to the deposited amount. It runs entirely in your browser — your secret never leaves this device. The first time, the proving key downloads (cached afterwards).'
          : 'The commitment hash is appended to the vault’s Merkle tree. Deposit amount is public; your balance details are not.'}</p>
        {txError && (() => {
          // Calm (neutral) for a wallet cancellation; red only when something actually failed.
          const isErr = txError.tone === 'error'
          return (
            <div className="panel mt-3" style={{ padding: 14, borderColor: isErr ? 'var(--red)' : 'var(--line-strong)', background: isErr ? 'oklch(0.70 0.18 25 / 0.06)' : 'transparent' }}>
              <div className="small" style={{ color: isErr ? 'var(--red)' : 'var(--text-2)', fontSize: 12 }}>
                <strong>{txError.title}</strong> — {txError.body}
              </div>
              {/* raw provider string kept available for a "details" disclosure if ever surfaced */}
              {txError.retry && (
                <button className="btn btn-sm mt-2" onClick={() => void (phase === 'prove' ? doProve() : phase === 'approve' || phase === 'wait-approve' ? doApprove() : doDeposit())}>Retry</button>
              )}
            </div>
          )
        })()}
        <div className="panel mt-4" style={{ padding: 20 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="mono" style={{ fontSize: 12, color: 'var(--cyan)' }}>{statusLabel}</span>
            <span className="mono" style={{ fontSize: 12 }}>{barPct}%</span>
          </div>
          <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, marginTop: 8 }}>
            <div style={{ height: 4, width: `${barPct}%`, background: 'var(--cyan)', borderRadius: 2, transition: 'width .4s ease' }} />
          </div>
          <div className="col gap-2 mt-4">
            {checks.map(([label, donePhases], i) => {
              const done = donePhases.includes(phase)
              // Highlight the row that's actively working right now (the proof row during 'prove').
              const active = !done && label === 'Deposit proof generated' && inProof
              return (
                <div key={i} className="row gap-3">
                  <span style={{ width: 14, height: 14, borderRadius: 4, border: '1px solid', display: 'flex', alignItems: 'center', justifyContent: 'center', borderColor: done ? 'var(--green)' : active ? 'var(--cyan)' : 'var(--line-strong)', background: done ? 'oklch(0.78 0.16 152 / 0.12)' : 'transparent', color: 'var(--green)' }}>
                    {done && <Icon d={ICONS.check} size={9} />}
                  </span>
                  <span className="mono" style={{ fontSize: 11, color: done ? 'var(--text)' : active ? 'var(--cyan)' : 'var(--text-2)' }}>{label}</span>
                </div>
              )
            })}
          </div>
          {approveTx && (
            <div className="mono mt-4" style={{ fontSize: 9, color: 'var(--text-3)' }}>Approve tx: {short(approveTx)}</div>
          )}
          {depositTx && (
            <div className="mono" style={{ fontSize: 9, color: 'var(--text-3)' }}>Deposit tx: {short(depositTx)}</div>
          )}
        </div>
        {phase === 'approve' && !txError && (
          <button className="btn btn-primary mt-4" onClick={() => void doApprove()} style={{ justifyContent: 'center', padding: '12px 24px' }}>
            Approve USDC spend <Icon d={ICONS.arrow} size={12} />
          </button>
        )}
      </div>
      <div>
        <div className="micro">MERKLE INSERTION</div>
        <div className="panel mt-3" style={{ padding: 24 }}>
          <MerkleInsertionVisual pct={txPct} />
        </div>
      </div>
    </div>
  )
}

// ── Step 2: done ─────────────────────────────────────────────────────────────

function Step2({ amount, commitment, txHash, onDone }: { amount: number; commitment: string; txHash: string; onDone: () => void }) {
  return (
    <div className="m-grid" style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 32 }}>
      <div>
        <div className="row gap-3">
          <div style={{ width: 40, height: 40, borderRadius: 8, background: 'oklch(0.78 0.16 152 / 0.18)', color: 'var(--green)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon d={ICONS.check} size={20} />
          </div>
          <div>
            <div className="micro" style={{ color: 'var(--green)' }}>DEPOSITED · {short(VAULT_ADDRESS)}</div>
            <h3 className="h3 mt-1" style={{ margin: 0 }}>You&apos;re in the pool.</h3>
          </div>
        </div>
        <p className="body mt-4">${amount.toLocaleString()} USDC is now part of the shared anonymity set. Your deposit is tied to your wallet — you can always recover your balance by reconnecting.</p>
        <div className="panel mt-6" style={{ padding: 20 }}>
          <KV l="Amount deposited" v={`$${amount.toLocaleString()} USDC`} />
          <KV l="Deposit tx" v={short(txHash)} />
        </div>
        <div className="row gap-3 mt-6">
          <button className="btn btn-primary" onClick={onDone}>Back to portfolio <Icon d={ICONS.arrow} size={12} /></button>
          {/* C3: explicit recovery path. If the local note ever drifts from chain (e.g. the tab was
              closed mid-flow on a prior attempt), Restore re-derives + re-syncs notes from chain. */}
          <Link href="/app/portfolio" className="btn btn-ghost" style={{ textDecoration: 'none' }}>
            Restore from chain
          </Link>
        </div>
      </div>
      <div>
        <div className="panel" style={{ padding: 20, borderColor: 'oklch(0.78 0.16 152 / 0.4)', background: 'oklch(0.78 0.16 152 / 0.03)' }}>
          <div className="row gap-3">
            <Icon d={ICONS.check} size={18} style={{ color: 'var(--green)', flexShrink: 0 }} />
            <div>
              <div className="h4" style={{ fontSize: 14 }}>Deposit saved in this browser.</div>
              <p className="small mt-2" style={{ fontSize: 12 }}>Your deposit details are cached locally for performance. Your secret is <strong>not</strong> stored — it&apos;s re-derived from your wallet signature on demand. You cannot lose access as long as you have this wallet.</p>
            </div>
          </div>
        </div>
        <div className="panel mt-3" style={{ padding: 20 }}>
          <div className="micro">NEXT STEPS</div>
          <div className="col mt-3 gap-3">
            {[['Browse markets', 'Find a market and place a private bet.'], ['Authorize a bet', 'Prove ownership with a ZK proof.']].map(([t, s], i) => (
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

// ── Root page ────────────────────────────────────────────────────────────────

export default function DepositPage() {
  const router = useRouter()
  const { address } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const publicClient = usePublicClient()
  const [step, setStep] = useState(0)
  // COPY-002: no aggressive five-figure default on a real-money beta vault — start empty so the
  // amount is a deliberate choice (quick-select chips remain for fast entry).
  const [amount, setAmount] = useState(0)
  const [deriving, setDeriving] = useState(false)

  // Derived note fields (computed during handleDeriveAndDeposit)
  const [commitment, setCommitment]     = useState<`0x${string}`>('0x')
  const [nullifier, setNullifier]       = useState<`0x${string}`>('0x')
  const [depositIndex, setDepositIndex] = useState(0)

  // Tx state
  const [phase, setPhase]         = useState<TxPhase>('prove')
  const [approveTx, setApproveTx] = useState<string | undefined>()
  const [depositTx, setDepositTx] = useState<string | undefined>()
  // Classified (humanized) error for the active step — drives calm vs red copy + the a11y announce.
  const [txError, setTxError]     = useState<ReturnType<typeof classifyTxError> | null>(null)
  const [finalTxHash, setFinalTxHash] = useState('')
  // Deposit-proof generation progress (the first tracked step). proofPct drives the bar; provingPhase
  // distinguishes the proving-key download from snarkjs crunching for the status label.
  const [proofPct, setProofPct]         = useState(0)
  const [provingPhase, setProvingPhase] = useState<'download' | 'prove' | null>(null)
  // Reload-resilience: a leftover deposit marker means a prior deposit may not have finished its local
  // note-cache update (tab closed / wallet flapped between submit and addNote). Non-alarming hint.
  const [staleDeposit, setStaleDeposit] = useState(false)

  const amountMicro = parseUnits(String(amount), 6)

  // ── USDC balance ──────────────────────────────────────────────────────────
  // Track resolution (isSuccess) so the UI never renders a defaulted 0n as a real "$0.00":
  // while the read is in flight we show a placeholder and hold the Confirm button. A connected
  // wallet with no pending read (enabled:false until `address` exists) counts as unresolved too.
  const { data: usdcBalance = 0n, isSuccess: balanceLoaded } = useReadContract({
    address: USDC_ADDRESS,
    abi: USDC_ABI,
    functionName: 'balanceOf',
    args: [address ?? '0x0000000000000000000000000000000000000000'],
    query: { enabled: !!address },
  })
  const balanceResolved = !!address && balanceLoaded

  // ── Per-address deposit cap (cumulative, on-chain) ─────────────────────────
  const { data: cumulativeDeposited = 0n, isSuccess: capLoaded } = useReadContract({
    address: VAULT_ADDRESS,
    abi: VAULT_ABI,
    functionName: 'cumulativeDeposits',
    args: [address ?? '0x0000000000000000000000000000000000000000'],
    query: { enabled: !!address && VAULT_ADDRESS !== '0x0000000000000000000000000000000000000000' },
  })
  const capResolved = !!address && capLoaded
  const remainingCapMicro =
    (cumulativeDeposited as bigint) >= DEPOSIT_CAP_MICRO ? 0n : DEPOSIT_CAP_MICRO - (cumulativeDeposited as bigint)
  const remainingCap = Number(remainingCapMicro) / 1e6

  // ── USDC allowance ────────────────────────────────────────────────────────
  const { data: allowance = 0n, refetch: refetchAllowance } = useReadContract({
    address: USDC_ADDRESS,
    abi: USDC_ABI,
    functionName: 'allowance',
    // FINDING: FUNC-002 — use the full zero address (matches the balanceOf call
    // above); '0x0' is not a valid 20-byte address arg for the ERC-20 ABI.
    args: [address ?? '0x0000000000000000000000000000000000000000', VAULT_ADDRESS],
    query: { enabled: !!address },
  })

  // ── MockUSDC mint (dev only) ──────────────────────────────────────────────
  const { writeContract: writeMint, isPending: minting } = useWriteContract()
  const mintUsdc = () => {
    writeMint({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'mint', args: [address!, parseUnits('100000', 6)] })
  }

  // ── USDC approve ──────────────────────────────────────────────────────────
  const { writeContract: writeApprove, data: approveTxHash, error: approveError } = useWriteContract()
  const { isSuccess: approveConfirmed } = useWaitForTransactionReceipt({ hash: approveTxHash })

  // ── Vault deposit ─────────────────────────────────────────────────────────
  const { writeContract: writeDeposit, data: depositTxHash, error: depositError } = useWriteContract()
  const { isSuccess: depositConfirmed, isError: depositReverted, error: depositReceiptError } = useWaitForTransactionReceipt({ hash: depositTxHash })
  // Guard against React Strict Mode double-invoking the deposit effect.
  const depositSubmittedRef = useRef(false)
  // FC-2: the mandatory deposit binding proof, generated client-side in the track's proof step
  // (doProve) and consumed by doDeposit.
  const depositProofRef = useRef<`0x${string}` | null>(null)
  // The note secret, held in memory only (never persisted) between key-derivation and proof
  // generation, so the proof step can build the binding proof. Cleared once the deposit is saved.
  const depositSecretRef = useRef<string | null>(null)
  // Re-entrancy guard for doProve (StrictMode double-invoke / retry).
  const provingRef = useRef(false)

  // ── State machine ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (approveTxHash) { setApproveTx(approveTxHash); setPhase('wait-approve') }
  }, [approveTxHash])

  useEffect(() => {
    if (approveConfirmed) { refetchAllowance(); setPhase('deposit') }
  }, [approveConfirmed, refetchAllowance])

  useEffect(() => {
    if (depositTxHash) { setDepositTx(depositTxHash); setPhase('wait-deposit') }
  }, [depositTxHash])

  useEffect(() => {
    if (depositConfirmed && depositTxHash && address) {
      // Record the index actually used (may exceed the local counter, since it came from the
      // on-chain deposit count) so it is never handed out again.
      recordDepositIndexUsed(address, depositIndex)
      addNote({
        id: commitment,
        kind: 'DEPOSIT',
        owner_address: address,
        depositIndex,
        balance: amountMicro,
        nonce: 0n,
        commitment,
        nullifier,
        spent: false,
        createdAt: Date.now(),
        txHash: depositTxHash,
        derivationVersion: 2, // FC-13: new deposits use the V2 master-seed scheme
      })
      recordWalletActivity({
        id: `deposit-${depositTxHash}`,
        wallet: address,
        kind: 'deposit',
        amount: amountMicro,
        createdAt: Date.now(),
        txHash: depositTxHash,
      })
      // The addNote above already updated the in-memory cache + persisted (encrypted) and fired the
      // notes-changed event, so the portfolio refreshes without a cache invalidation here.
      depositSecretRef.current = null // note saved — drop the in-memory secret
      // Note is persisted + index recorded — clear the recovery breadcrumb and the in-flight flag.
      clearDepositMarker(address, commitment)
      clearMoneyOpInFlight()
      setFinalTxHash(depositTxHash)
      setPhase('done')
      setStep(2)
      // C4: nudge the proof-relay to pull this fresh deposit (leaf + Deposited event) into its caches
      // now — the relay doesn't originate deposit txs, so otherwise it waits for the slow reconcile.
      // Fire-and-forget; recovery/merkle paths still work without it.
      void fetch('/api/relay/deposit-hint', { method: 'POST' }).catch(() => {})
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depositConfirmed])

  useEffect(() => {
    if (approveError) {
      // Humanize: a rejected approval reads as a calm "Cancelled in your wallet", not a red failure.
      const c = classifyTxError(approveError)
      setTxError(c); setPhase('approve')
      // No USDC has moved yet (approval failed before the deposit tx). Release the in-flight flag so a
      // disconnect during the paused step performs normal hygiene; the user can re-approve to resume.
      clearMoneyOpInFlight()
    }
  }, [approveError])

  useEffect(() => {
    if (depositError) {
      setTxError(classifyTxError(depositError))
      depositSubmittedRef.current = false // allow retry
      // A deposit write error before broadcast means no funds left the wallet (the marker is only
      // written once we're about to submit, and is cleared on save) — release the flag.
      clearMoneyOpInFlight()
    }
  }, [depositError])

  useEffect(() => {
    if (depositReverted) {
      // H10: a confirmed on-chain revert. NEVER guess the cause — the prior copy seeded a literal
      // "deposit cap" string, which made classifyTxError match its cap rule and wrongly tell the user
      // to lower a valid amount even when the real cause was InvalidProof / allowance / paused.
      // Pass the REAL error object (the receipt-wait error often carries a decoded revert reason);
      // if it has no usable reason, fall back to a neutral, cause-free message that names nothing.
      const real = depositReceiptError
      const hasReason = real instanceof Error && (real.message?.trim().length ?? 0) > 0
      setTxError(
        hasReason
          ? classifyTxError(real)
          : classifyTxError('Deposit reverted on-chain — Restore from your Portfolio and retry, or contact support.'),
      )
      depositSubmittedRef.current = false // allow retry
      clearMoneyOpInFlight() // the in-flight phase has terminated (reverted)
    }
  }, [depositReverted, depositReceiptError])

  // Reload resilience: surface a one-line hint if a prior deposit left a pending marker for this
  // wallet (it may not have finished syncing locally). We do NOT auto-reconcile — Restore handles that.
  useEffect(() => {
    if (!address) { setStaleDeposit(false); return }
    setStaleDeposit(getDepositMarkers(address).length > 0)
  }, [address])

  // C3 (money-loss prevention): while the deposit is in-flight (proof generation through on-chain
  // confirmation), warn before a refresh/close so the user doesn't kill the flow after the USDC has
  // left the wallet but before the note is persisted. Mirrors the withdraw page's beforeunload guard.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const inFlight = step === 1 && phase !== 'done'
    if (!inFlight) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [step, phase])

  // ── Handlers ──────────────────────────────────────────────────────────────

  async function handleDeriveAndDeposit() {
    if (!address) return
    setDeriving(true)
    try {
      // Collision-proof index. The localStorage counter resets to 0 on a cache wipe, which previously
      // re-derived an OLD index → a note with an already-spent nullifier → LOCKED funds. Start from the
      // on-chain deposit count, then bump past any index whose nullifier is already spent on-chain (a
      // nonce-0 note has exactly one nullifier, so depositing onto a spent one is unrecoverable).
      let index = await getSafeNextDepositIndex(address)
      // FC-13: new deposits use the V2 master seed. The first call signs once to unlock the seed;
      // every re-derivation below (collision-guard) is then free (no extra wallet prompt).
      let secret = await getNoteSecret(signMessageAsync, address, index, 2)
      let n = computeNullifier(secret, 0n)
      for (let guard = 0; guard < 20; guard++) {
        const spent = await fetchSpentNullifiers(VAULT_ADDRESS, [n])
        if (!spent.has(n.toLowerCase())) break
        console.warn('[deposit] index', index, 'has a spent nullifier — bumping to avoid a locked deposit')
        index += 1
        secret = await getNoteSecret(signMessageAsync, address, index, 2)
        n = computeNullifier(secret, 0n)
      }
      const c = computeCommitment(secret, amountMicro, 0n, address)
      setCommitment(c); setNullifier(n); setDepositIndex(index)
      console.log('[deposit] note derived from wallet signature', { commitment: c, index })

      // Hold the secret in memory (never persisted) so the track's proof step can build the FC-2
      // binding proof. Proof generation now runs IN the track (Step 1, phase 'prove') with a progress
      // bar — instead of blocking here invisibly — so the user sees the (first-time-download) work.
      depositSecretRef.current = secret
      depositProofRef.current = null
      provingRef.current = false
      setProofPct(0); setProvingPhase('download')
      setTxError(null)
      depositSubmittedRef.current = false // reset for fresh attempt
      // C3/H7: mark a money op in flight so a wallet flap / account switch during the deposit doesn't
      // trigger WalletConnect's destructive wipe (which would destroy the just-derived note's
      // deposit-index counter + encrypted cache before the note is persisted). Cleared on done/abort.
      setMoneyOpInFlight()
      setStaleDeposit(false)
      setPhase('prove')
      setStep(1)
    } catch (err) {
      setTxError(classifyTxError(err))
      console.error('[deposit] deriveSecret failed:', err)
    } finally {
      setDeriving(false)
    }
  }

  // FC-2 (T20): generate the mandatory deposit binding proof — the first tracked step. Binds the hidden
  // balance + owner to the transferred amount + msg.sender. Runs in a Web Worker so the UI stays
  // responsive, streaming download/prove progress to the bar. On success, advances to approve/deposit.
  async function doProve() {
    if (provingRef.current || depositProofRef.current) return
    const secret = depositSecretRef.current
    if (!secret || !address) {
      setTxError(classifyTxError('Deposit secret unavailable — please restart the deposit.'))
      return
    }
    provingRef.current = true
    setTxError(null)
    setProofPct(0); setProvingPhase('download')
    try {
      const { proof } = await generateProofInWorker(
        { type: 'deposit', inputs: { secret, commitment, amount: amountMicro, owner_address: BigInt(address).toString() } },
        (p) => {
          setProvingPhase(p.phase)
          if (p.phase === 'download') {
            // Cap the download segment at 95% so the bar visibly finishes during the proving tail.
            setProofPct(p.total > 0 ? Math.min(95, Math.round((p.loaded / p.total) * 95)) : 0)
          } else {
            // snarkjs crunching — no granular signal; hold near-complete until it resolves.
            setProofPct((cur) => Math.max(cur, 96))
          }
        },
      )
      depositProofRef.current = proof
      setProofPct(100); setProvingPhase(null)
      console.log('[deposit] binding proof generated')
      // Proof in hand → approve, or skip straight to deposit if the allowance already covers it.
      if (allowance >= amountMicro) {
        setPhase('deposit')
      } else {
        setPhase('approve')
        void doApprove()
      }
    } catch (err) {
      setTxError(classifyTxError(err))
      setProvingPhase(null)
      console.error('[deposit] proof generation failed:', err)
    } finally {
      provingRef.current = false
    }
  }

  // Polygon enforces a minimum priority fee (~25–30 gwei). When the wallet/estimator populates a tx
  // below it, the wallet rejects with "gas price too low" (page.signTx.errorRetry.gasPriceTooLow).
  // Floor the priority fee (and bump maxFee to match) so the deposit/approve always carry a valid
  // Polygon gas price. Dev (anvil) needs no floor, and an estimate failure falls back to a static floor.
  async function txFees(): Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }> {
    if (IS_DEV || !publicClient) return {}
    const FLOOR = 30_000_000_000n // 30 gwei
    try {
      const { maxFeePerGas, maxPriorityFeePerGas } = await publicClient.estimateFeesPerGas()
      const prio = maxPriorityFeePerGas && maxPriorityFeePerGas > FLOOR ? maxPriorityFeePerGas : FLOOR
      const bump = prio - (maxPriorityFeePerGas ?? 0n)
      const maxFee = (maxFeePerGas ?? prio * 2n) + (bump > 0n ? bump : 0n)
      return { maxFeePerGas: maxFee, maxPriorityFeePerGas: prio }
    } catch {
      return { maxFeePerGas: FLOOR * 3n, maxPriorityFeePerGas: FLOOR }
    }
  }

  // NOTE: do NOT pass an explicit `nonce`. The wallet broadcasts to its OWN RPC and tracks its own
  // pending txs; computing a nonce from our RPC (the /api/rpc proxy → Ankr) — especially with
  // blockTag 'latest', which ignores pending txs — can hand the wallet a too-low/gapped nonce, so the
  // tx sits in the mempool unmined ("stuck on Included in block"). Let the wallet assign the nonce.
  async function doApprove() {
    writeApprove({
      address: USDC_ADDRESS,
      abi: USDC_ABI,
      functionName: 'approve',
      args: [VAULT_ADDRESS, amountMicro * 2n],
      ...(await txFees()),
    })
  }

  async function doDeposit() {
    if (depositSubmittedRef.current) return
    if (!depositProofRef.current) {
      setTxError(classifyTxError('Deposit binding proof missing. Please restart the deposit.'))
      return
    }
    depositSubmittedRef.current = true // set synchronously before any await
    // C3 (reload/crash resilience): record a recovery breadcrumb JUST BEFORE submit so a tab close /
    // wallet flap between the on-chain tx and the local addNote can be detected on next mount (PUBLIC
    // data only — commitment + deposit index + amount, no secret). Cleared once the note is saved.
    if (address) {
      markDepositSubmitted(address, {
        commitment,
        depositIndex,
        amountMicro: amountMicro.toString(),
        submittedAt: Date.now(),
      })
    }
    writeDeposit({
      address: VAULT_ADDRESS,
      abi: VAULT_ABI,
      functionName: 'deposit',
      args: [depositProofRef.current, commitment, amountMicro],
      ...(await txFees()),
    })
  }

  const steps: [string, string, string][] = [
    ['01', 'Amount',   'Choose deposit size.'],
    ['02', 'On-chain', 'Approve + deposit tx submitted.'],
    ['03', 'Done',     'Deposit complete. Ready to authorize bets.'],
  ]

  // WCAG 4.1.3 — announce the multi-step deposit (proof → approve → deposit → done) and any
  // failure to assistive tech; the long proof/tx steps are otherwise silent.
  const depositAnnounce = txError
    ? `${txError.title}: ${txError.body}`
    : step === 2
      ? 'Deposit complete. You are in the pool.'
      : step === 1
        ? phase === 'prove'
          ? provingPhase === 'prove' ? 'Generating deposit proof…' : 'Downloading proving key…'
          : phase === 'approve' ? 'Waiting for USDC approval in your wallet…'
          : phase === 'wait-approve' ? 'Confirming approval on-chain…'
          : phase === 'deposit' ? 'Submitting deposit…'
          : phase === 'wait-deposit' ? 'Confirming deposit on-chain…'
          : ''
        : ''

  return (
    <FlowShell
      title="Deposit USDC"
      kicker="DEPOSIT · PRIVATE"
      summary={`$${amount.toLocaleString()} USDC · vault ${short(VAULT_ADDRESS)}`}
      steps={steps}
      step={step}
      onBack={() => router.push('/app/vault')}
    >
      <LiveRegion message={depositAnnounce} assertive={txError?.tone === 'error'} />
      {staleDeposit && step === 0 && (
        <div className="small" style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 12 }}>
          A previous deposit may not have finished syncing locally — if your balance looks off, tap{' '}
          <Link href="/app/portfolio" style={{ color: 'var(--cyan)' }}>Restore on the Portfolio</Link>.
        </div>
      )}
      {step === 0 && (
        <Step0
          amount={amount} setAmount={setAmount} onNext={handleDeriveAndDeposit} deriving={deriving}
          usdcBalance={usdcBalance as bigint} mintUsdc={mintUsdc} minting={minting}
          remainingCap={remainingCap}
          balanceResolved={balanceResolved} capResolved={capResolved}
        />
      )}
      {step === 1 && (
        <Step1
          amount={amount} commitment={commitment}
          onDone={(hash) => { setFinalTxHash(hash); setStep(2) }}
          phase={phase} setPhase={setPhase}
          approveTx={approveTx} depositTx={depositTx} txError={txError}
          doApprove={doApprove} doDeposit={doDeposit}
          doProve={doProve} proofPct={proofPct} provingPhase={provingPhase}
        />
      )}
      {step === 2 && (
        <Step2
          amount={amount} commitment={commitment} txHash={finalTxHash}
          onDone={() => router.push('/app/portfolio')}
        />
      )}
    </FlowShell>
  )
}
