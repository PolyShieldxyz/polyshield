'use client'
import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContract, useSignMessage, usePublicClient } from 'wagmi'
import { parseUnits } from 'viem'
import { FlowShell } from '@/components/app/FlowShell'
import { KV } from '@/components/app/KV'
import { Icon, ICONS } from '@/components/ui/Icon'
import { VAULT_ABI, USDC_ABI } from '@/lib/vaultAbi'
import {
  deriveSecret, computeCommitment, computeNullifier,
  getSafeNextDepositIndex, recordDepositIndexUsed, addNote, clearNoteCache, recordWalletActivity,
} from '@/lib/notes'
import { fetchSpentNullifiers } from '@/lib/api'
import { generateDepositProof } from '@/lib/prover'

const IS_DEV = process.env.NEXT_PUBLIC_DEV_MODE === 'true'
const VAULT_ADDRESS = (process.env.NEXT_PUBLIC_VAULT_ADDRESS ?? '0x0000000000000000000000000000000000000000') as `0x${string}`
const USDC_ADDRESS  = (process.env.NEXT_PUBLIC_USDC_ADDRESS  ?? '0x0000000000000000000000000000000000000000') as `0x${string}`

function short(hex: string) { return hex.slice(0, 8) + '…' + hex.slice(-6) }

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
        const color = isNew ? 'oklch(0.85 0.13 210)' : i < 5 ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.2)'
        return (
          <g key={i}>
            {isNew && pct < 100 && <circle cx={x} cy={140} r={8} fill="oklch(0.82 0.13 210 / 0.2)" />}
            <circle cx={x} cy={140} r="5" fill={color} opacity={opacity} />
            {isNew && <text x={x} y={170} textAnchor="middle" fontFamily="JetBrains Mono" fontSize="9" fill="oklch(0.82 0.13 210)">NEW</text>}
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
  usdcBalance, mintUsdc, minting,
}: {
  amount: number
  setAmount: (v: number) => void
  onNext: () => void
  deriving: boolean
  usdcBalance: bigint
  mintUsdc: () => void
  minting: boolean
}) {
  const balanceFormatted = (Number(usdcBalance) / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const insufficient = usdcBalance < parseUnits(String(amount), 6)

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 32 }}>
      <div>
        <div className="micro">DEPOSIT AMOUNT</div>
        <h3 className="h3 mt-3" style={{ margin: 0 }}>How much USDC?</h3>
        <p className="body mt-3">Funds enter the shared anonymity pool. They are not linkable to any future bets you authorize from them.</p>
        <div className="mt-6">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="micro">AMOUNT</div>
            {IS_DEV && (
              <div className="row gap-3">
                <span className="small" style={{ fontSize: 11, color: 'var(--text-3)' }}>Balance: ${balanceFormatted}</span>
                <button className="btn btn-sm" style={{ fontSize: 10, padding: '3px 8px' }} onClick={mintUsdc} disabled={minting}>
                  {minting ? 'Minting…' : '+ Get test USDC'}
                </button>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg-1)', border: `1px solid ${insufficient && amount > 0 ? 'var(--red)' : 'var(--line-strong)'}`, borderRadius: 6, padding: '0 14px', marginTop: 8 }}>
            <span className="mono" style={{ color: 'var(--text-2)', marginRight: 8, fontSize: 20 }}>$</span>
            {/* FINDING: A11Y-002 aria-label (no associated <label>); A11Y-001 dropped inline outline:none so the global :focus-visible ring applies. */}
            <input type="number" value={amount} onChange={(e) => setAmount(Math.max(0, +e.target.value || 0))}
              aria-label="Deposit amount in USDC"
              style={{ background: 'transparent', border: 'none', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 28, padding: '16px 0', width: '100%' }} />
            <span className="mono" style={{ color: 'var(--text-2)', fontSize: 14, letterSpacing: '0.06em' }}>USDC</span>
          </div>
          {insufficient && amount > 0 && (
            <div className="small mt-1" style={{ fontSize: 11, color: 'var(--red)' }}>Insufficient USDC balance{IS_DEV && ' — click "+ Get test USDC" above'}</div>
          )}
          <div className="row mt-2 gap-2">
            {[5000, 10000, 25000, 50000].map((v) => (
              <button key={v} onClick={() => setAmount(v)} className={`btn btn-sm ${amount === v ? 'btn-cyan' : 'btn-ghost'}`} style={{ flex: 1, justifyContent: 'center', padding: '6px 0', fontSize: 11 }}>
                ${v >= 1000 ? `${v / 1000}k` : v}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div>
        <div className="micro">SUMMARY</div>
        <div className="panel mt-3" style={{ padding: 20 }}>
          <KV l="Amount" v={`$${amount.toLocaleString()} USDC`} />
          <KV l="Vault" v={VAULT_ADDRESS ? short(VAULT_ADDRESS) : '(not connected)'} />
          <KV l="Anonymity set" v="1,842 wallets" />
          <KV l="Network fee" v="~$0.04 (Polygon)" />
          <KV l="Polyshield fee" v="$0.00" />
          <KV l="Key derivation" v="Poseidon4(wallet_sig_hash, …)" />
          {IS_DEV && <KV l="Mode" v="DEV — MockVerifier" />}
          <button
            className="btn btn-primary mt-4"
            style={{ width: '100%', justifyContent: 'center', padding: '14px 0', fontSize: 13 }}
            onClick={onNext}
            disabled={amount <= 0 || insufficient || deriving}
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

type TxPhase = 'approve' | 'wait-approve' | 'deposit' | 'wait-deposit' | 'done'

function Step1({
  amount, commitment, onDone,
  phase, setPhase, approveTx, depositTx, txError,
  doApprove, doDeposit,
}: {
  amount: number
  commitment: string
  onDone: (txHash: string) => void
  phase: TxPhase
  setPhase: (p: TxPhase) => void
  approveTx: string | undefined
  depositTx: string | undefined
  txError: string | null
  doApprove: () => void | Promise<void>
  doDeposit: () => void | Promise<void>
}) {
  const checks: [string, TxPhase[]][] = [
    ['USDC spend approved',       ['wait-approve', 'deposit', 'wait-deposit', 'done']],
    ['Deposit transaction signed', ['wait-deposit', 'done']],
    ['Broadcast to RPC',           ['wait-deposit', 'done']],
    ['Included in block',          ['done']],
    ['Merkle leaf appended',       ['done']],
  ]

  const pct = { approve: 0, 'wait-approve': 20, deposit: 40, 'wait-deposit': 65, done: 100 }[phase]

  useEffect(() => {
    if (phase === 'deposit') void doDeposit()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  useEffect(() => {
    if (phase === 'done' && depositTx) onDone(depositTx)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, depositTx])

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32 }}>
      <div>
        <div className="micro">VAULT SUBMIT · ON-CHAIN</div>
        <h3 className="h3 mt-3" style={{ margin: 0 }}>Submitting deposit on-chain.</h3>
        <p className="body mt-3">The commitment hash is appended to the vault&apos;s Merkle tree. Deposit amount is public; your balance details are not.</p>
        {txError && (
          <div className="panel mt-3" style={{ padding: 14, borderColor: 'var(--red)', background: 'oklch(0.70 0.18 25 / 0.06)' }}>
            <div className="small" style={{ color: 'var(--red)', fontSize: 12 }}>Transaction failed: {txError}</div>
            <button className="btn btn-sm mt-2" onClick={() => void (phase === 'approve' || phase === 'wait-approve' ? doApprove() : doDeposit())}>Retry</button>
          </div>
        )}
        <div className="panel mt-4" style={{ padding: 20 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="mono" style={{ fontSize: 12, color: 'var(--cyan)' }}>
              {phase === 'approve' ? 'waiting for approval…' : phase === 'wait-approve' ? 'confirming approval…' : phase === 'deposit' ? 'submitting deposit…' : phase === 'wait-deposit' ? 'confirming deposit…' : 'complete'}
            </span>
            <span className="mono" style={{ fontSize: 12 }}>{pct}%</span>
          </div>
          <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, marginTop: 8 }}>
            <div style={{ height: 4, width: `${pct}%`, background: 'var(--cyan)', borderRadius: 2, transition: 'width .5s ease' }} />
          </div>
          <div className="col gap-2 mt-4">
            {checks.map(([label, donePhases], i) => {
              const done = donePhases.includes(phase)
              return (
                <div key={i} className="row gap-3">
                  <span style={{ width: 14, height: 14, borderRadius: 4, border: '1px solid', display: 'flex', alignItems: 'center', justifyContent: 'center', borderColor: done ? 'var(--green)' : 'var(--line-strong)', background: done ? 'oklch(0.78 0.16 152 / 0.12)' : 'transparent', color: 'var(--green)' }}>
                    {done && <Icon d={ICONS.check} size={9} />}
                  </span>
                  <span className="mono" style={{ fontSize: 11, color: done ? 'var(--text)' : 'var(--text-2)' }}>{label}</span>
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
          <MerkleInsertionVisual pct={pct} />
        </div>
      </div>
    </div>
  )
}

// ── Step 2: done ─────────────────────────────────────────────────────────────

function Step2({ amount, commitment, txHash, onDone }: { amount: number; commitment: string; txHash: string; onDone: () => void }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 32 }}>
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
          <KV l="Vault anonymity set" v="[live count coming soon]" />
        </div>
        <div className="row gap-3 mt-6">
          <button className="btn btn-primary" onClick={onDone}>Back to portfolio <Icon d={ICONS.arrow} size={12} /></button>
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
  const [amount, setAmount] = useState(25000)
  const [deriving, setDeriving] = useState(false)

  // Derived note fields (computed during handleDeriveAndDeposit)
  const [commitment, setCommitment]     = useState<`0x${string}`>('0x')
  const [nullifier, setNullifier]       = useState<`0x${string}`>('0x')
  const [depositIndex, setDepositIndex] = useState(0)

  // Tx state
  const [phase, setPhase]         = useState<TxPhase>('approve')
  const [approveTx, setApproveTx] = useState<string | undefined>()
  const [depositTx, setDepositTx] = useState<string | undefined>()
  const [txError, setTxError]     = useState<string | null>(null)
  const [finalTxHash, setFinalTxHash] = useState('')

  const amountMicro = parseUnits(String(amount), 6)

  // ── USDC balance ──────────────────────────────────────────────────────────
  const { data: usdcBalance = 0n } = useReadContract({
    address: USDC_ADDRESS,
    abi: USDC_ABI,
    functionName: 'balanceOf',
    args: [address ?? '0x0000000000000000000000000000000000000000'],
    query: { enabled: !!address },
  })

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
  const { isSuccess: depositConfirmed, isError: depositReverted } = useWaitForTransactionReceipt({ hash: depositTxHash })
  // Guard against React Strict Mode double-invoking the deposit effect.
  const depositSubmittedRef = useRef(false)
  // FC-2: the mandatory deposit binding proof, generated client-side from the
  // in-scope secret in handleDeriveAndDeposit and consumed by doDeposit.
  const depositProofRef = useRef<`0x${string}` | null>(null)

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
      })
      recordWalletActivity({
        id: `deposit-${depositTxHash}`,
        wallet: address,
        kind: 'deposit',
        amount: amountMicro,
        createdAt: Date.now(),
        txHash: depositTxHash,
      })
      // Invalidate in-memory cache so the portfolio page reads fresh balance from localStorage
      clearNoteCache()
      setFinalTxHash(depositTxHash)
      setPhase('done')
      setStep(2)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depositConfirmed])

  useEffect(() => {
    if (approveError) { setTxError(approveError.message.split('\n')[0]); setPhase('approve') }
  }, [approveError])

  useEffect(() => {
    if (depositError) {
      setTxError(depositError.message.split('\n')[0])
      depositSubmittedRef.current = false // allow retry
    }
  }, [depositError])

  useEffect(() => {
    if (depositReverted) {
      setTxError('Deposit transaction reverted on-chain. Check your deposit cap or retry.')
      depositSubmittedRef.current = false // allow retry
    }
  }, [depositReverted])

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
      let secret = await deriveSecret(signMessageAsync, address, index)
      let n = computeNullifier(secret, 0n)
      for (let guard = 0; guard < 20; guard++) {
        const spent = await fetchSpentNullifiers(VAULT_ADDRESS, [n])
        if (!spent.has(n.toLowerCase())) break
        console.warn('[deposit] index', index, 'has a spent nullifier — bumping to avoid a locked deposit')
        index += 1
        secret = await deriveSecret(signMessageAsync, address, index)
        n = computeNullifier(secret, 0n)
      }
      const c = computeCommitment(secret, amountMicro, 0n, address)
      setCommitment(c); setNullifier(n); setDepositIndex(index)
      console.log('[deposit] note derived from wallet signature', { commitment: c, index })

      // FC-2 (T20): generate the mandatory deposit binding proof. Binds the hidden
      // balance + owner to the transferred amount + msg.sender. Secret stays client-side.
      const { proof } = await generateDepositProof({
        secret,
        commitment: c,
        amount: amountMicro,
        owner_address: BigInt(address).toString(),
      })
      depositProofRef.current = proof
      console.log('[deposit] binding proof generated')

      setTxError(null)
      depositSubmittedRef.current = false // reset for fresh attempt
      setPhase('approve')
      setStep(1)

      if (allowance >= amountMicro) {
        // Skip approve — let Step1's useEffect call doDeposit() as the single call site.
        setPhase('deposit')
      } else {
        void doApprove()
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setTxError(msg.split('\n')[0])
      console.error('[deposit] deriveSecret failed:', err)
    } finally {
      setDeriving(false)
    }
  }

  async function doApprove() {
    const nonce = await publicClient!.getTransactionCount({ address: address!, blockTag: 'latest' })
    writeApprove({
      address: USDC_ADDRESS,
      abi: USDC_ABI,
      functionName: 'approve',
      args: [VAULT_ADDRESS, amountMicro * 2n],
      nonce,
    })
  }

  async function doDeposit() {
    if (depositSubmittedRef.current) return
    if (!depositProofRef.current) {
      setTxError('Deposit binding proof missing. Please restart the deposit.')
      return
    }
    depositSubmittedRef.current = true // set synchronously before any await
    const nonce = await publicClient!.getTransactionCount({ address: address!, blockTag: 'latest' })
    writeDeposit({
      address: VAULT_ADDRESS,
      abi: VAULT_ABI,
      functionName: 'deposit',
      args: [depositProofRef.current, commitment, amountMicro],
      nonce,
    })
  }

  const steps: [string, string, string][] = [
    ['01', 'Amount',   'Choose deposit size.'],
    ['02', 'On-chain', 'Approve + deposit tx submitted.'],
    ['03', 'Done',     'Deposit complete. Ready to authorize bets.'],
  ]

  return (
    <FlowShell
      title="Deposit USDC"
      kicker="DEPOSIT · PRIVATE"
      summary={`$${amount.toLocaleString()} USDC · vault ${short(VAULT_ADDRESS)}`}
      steps={steps}
      step={step}
      onBack={() => router.push('/app/vault')}
    >
      {step === 0 && (
        <Step0
          amount={amount} setAmount={setAmount} onNext={handleDeriveAndDeposit} deriving={deriving}
          usdcBalance={usdcBalance as bigint} mintUsdc={mintUsdc} minting={minting}
        />
      )}
      {step === 1 && (
        <Step1
          amount={amount} commitment={commitment}
          onDone={(hash) => { setFinalTxHash(hash); setStep(2) }}
          phase={phase} setPhase={setPhase}
          approveTx={approveTx} depositTx={depositTx} txError={txError}
          doApprove={doApprove} doDeposit={doDeposit}
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
