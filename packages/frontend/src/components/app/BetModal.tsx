'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAccount, useSignMessage } from 'wagmi'
import { Modal } from '@/components/app/Modal'
import { Icon, ICONS } from '@/components/ui/Icon'
import { KV } from '@/components/app/KV'
import {
  addNote,
  computeCommitment,
  computeNullifier,
  deriveSecret,
  formatUsdc,
  getCurrentCashNote,
  markNoteSpent,
  positionToField,
  recordWalletActivity,
  selectNotesForAmount,
  toFieldSafe,
  type Note,
} from '@/lib/notes'
import { consolidateNotes } from '@/lib/consolidate'
import { fetchMerklePath, relayBet, requestLimitOrder, waitForTransactionConfirmation } from '@/lib/api'
import { generateProofInWorker } from '@/lib/prover'
import { log, proofSummary } from '@/lib/logger'

type Phase = 'edit' | 'running' | 'success' | 'error'
type OrderType = 'FOK' | 'FAK' | 'GTC' | 'GTD'
const VAULT_ADDRESS = (process.env.NEXT_PUBLIC_VAULT_ADDRESS ??
  '0x0000000000000000000000000000000000000000') as `0x${string}`

interface BetModalProps {
  open: boolean
  marketId: string
  marketName: string
  conditionId: `0x${string}`
  side: 'YES' | 'NO'
  initialAmount: number
  price: number
  onClose: () => void
  onSuccess?: () => void | Promise<void>
}

function parseUsdcToMicro(value: string): bigint | null {
  const normalized = value.trim()
  if (!normalized) return null
  if (!/^\d*(\.\d{0,6})?$/.test(normalized)) return null
  const [wholeRaw, fracRaw = ''] = normalized.split('.')
  const whole = wholeRaw.length === 0 ? 0n : BigInt(wholeRaw)
  const frac = BigInt((fracRaw + '000000').slice(0, 6))
  return whole * 1_000_000n + frac
}

function formatUsdcInput(micro: bigint): string {
  const whole = micro / 1_000_000n
  const frac = micro % 1_000_000n
  const fracText = frac.toString().padStart(6, '0').replace(/0+$/, '')
  return fracText ? `${whole.toString()}.${fracText}` : whole.toString()
}

export function BetModal({
  open,
  marketId,
  marketName,
  conditionId,
  side,
  initialAmount,
  price,
  onClose,
  onSuccess,
}: BetModalProps) {
  const { address } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const [amountInput, setAmountInput] = useState(formatUsdcInput(BigInt(initialAmount) * 1_000_000n))
  const [phase, setPhase] = useState<Phase>('edit')
  const [error, setError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState('')
  const [autoSettle, setAutoSettle] = useState(true)
  // FINDING: FUNC-001 — drive the progress bar from real elapsed time (not a fake
  // hardcoded width) and surface an honest "this can take a while" message.
  const [progress, setProgress] = useState(5)
  // FINDING: FUNC-001 — set when the worker fails and the prover falls back to the
  // main thread (polyshield:prover-fallback event), so we can tell the user.
  const [fallbackNote, setFallbackNote] = useState<string | null>(null)
  // FC-4: advanced order types. FOK (default) = today's behavior; GTC/GTD rest on
  // the book at the user's limit price (gated advanced mode pending live-API testing).
  const [orderType, setOrderType] = useState<OrderType>('FOK')
  const [limitCents, setLimitCents] = useState(Math.max(1, Math.min(99, Math.round(price * 100))))
  const [gtdMinutes, setGtdMinutes] = useState(60)

  useEffect(() => {
    if (!open) return
    setAmountInput(formatUsdcInput(BigInt(initialAmount) * 1_000_000n))
    setPhase('edit')
    setError(null)
    setTxHash('')
    setAutoSettle(true)
    setProgress(5)
    setFallbackNote(null)
    setOrderType('FOK')
    setLimitCents(Math.max(1, Math.min(99, Math.round(price * 100))))
    setGtdMinutes(60)
  }, [open, initialAmount, marketId, price])

  // FINDING: FUNC-001 — advance the progress bar from ~5% toward ~90% over ~120s
  // while proving. It approaches 90% asymptotically and never reaches 100% until
  // the proof actually completes (phase leaves 'running'), so the bar reflects
  // honest "still working" state rather than a fixed 72% lie. Resets on phase
  // change away from 'running'.
  useEffect(() => {
    if (phase !== 'running') {
      setProgress(5)
      return
    }
    const start = Date.now()
    const id = window.setInterval(() => {
      const elapsed = (Date.now() - start) / 1000
      // Asymptotic ease toward 90% with a ~120s time constant.
      const next = 90 - 85 * Math.exp(-elapsed / 120)
      setProgress((prev) => Math.max(prev, Math.min(90, next)))
    }, 500)
    return () => window.clearInterval(id)
  }, [phase])

  // FINDING: FUNC-001 — when the Web Worker prover fails and falls back to the main
  // thread (prover.ts dispatches polyshield:prover-fallback), warn the user that it
  // will be slower and may need a more powerful device.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onFallback = () => {
      setFallbackNote(
        'Proof is taking longer on this device — falling back. If it fails, try again on a more powerful device (desktop with more RAM).',
      )
    }
    window.addEventListener('polyshield:prover-fallback', onFallback)
    return () => window.removeEventListener('polyshield:prover-fallback', onFallback)
  }, [])

  // FOK fills at the market price; a limit order fills at most at the user's tick-snapped
  // limit price (cents). The bet_auth proof is built at this effective price.
  const effectivePrice = useMemo(
    // FOK and FAK are market orders (use the live market price); GTC/GTD rest at the
    // user's limit price.
    () => (orderType === 'FOK' || orderType === 'FAK' ? price : limitCents / 100),
    [orderType, price, limitCents],
  )
  const amountMicro = useMemo(() => parseUsdcToMicro(amountInput), [amountInput])
  const shares = useMemo(() => {
    if (!amountMicro || effectivePrice <= 0) return 0n
    return (amountMicro * 100_000_000n) / BigInt(Math.round(effectivePrice * 100_000_000))
  }, [amountMicro, effectivePrice])

  const submit = async () => {
    if (!address || !amountMicro || amountMicro <= 0n) return
    let cashNote = getCurrentCashNote(address)
    if (!cashNote) {
      const msg = 'No available cash balance to place this bet. Deposit USDC first.'
      console.error('[BetModal] submit: no spendable note found for', address)
      setPhase('error')
      setError(msg)
      return
    }
    // FC-8: a single note need not cover the stake — up to 4 notes can be merged first.
    // Reject only when even the largest 4 notes can't cover it.
    if (amountMicro > cashNote.balance) {
      const sel = selectNotesForAmount(address, amountMicro)
      if (!sel.ok) {
        console.error('[BetModal] submit: amount exceeds combinable balance', { amount: amountMicro })
        setPhase('error')
        setError(sel.error)
        return
      }
    }

    setPhase('running')
    setError(null)
    setTxHash('')

    try {
      const stake = amountMicro
      // FC-8: if no single note covers the stake, consolidate up to 4 notes into one
      // (a merge proof + tx via the relay), then bet from the merged note.
      if (stake > cashNote.balance) {
        const sel = selectNotesForAmount(address, stake)
        if (!sel.ok) throw new Error(sel.error)
        cashNote = await consolidateNotes({
          wallet: address,
          signMessageAsync,
          notes: sel.selection.notes,
          onProgress: (m) => log('bet_modal_consolidate', { step: m }),
        })
      }
      const secret = await deriveSecret(signMessageAsync, address, cashNote.depositIndex)
      let merkleProof
      try {
        merkleProof = await fetchMerklePath(cashNote.commitment)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.includes('not found')) {
          throw new Error('Your note is not in the current chain tree. The chain may have been reset — please refresh the page and deposit again.')
        }
        throw e
      }
      const merkleRoot = merkleProof.root
      const newBalance = cashNote.balance - stake
      const newNonce = cashNote.nonce + 1n
      const newCommitment = computeCommitment(secret, newBalance, newNonce, address)
      const newNullifier = computeNullifier(secret, newNonce)
      const nullifierHex = computeNullifier(secret, cashNote.nonce)
      const safeConditionId = toFieldSafe(conditionId)
      const positionId = positionToField(conditionId, side)
      const priceScaled = BigInt(Math.round(effectivePrice * 100_000_000))
      const shareRemainder = (stake * 100_000_000n) % priceScaled

      const { proof } = await generateProofInWorker({
        type: 'bet_auth',
        inputs: {
          secret,
          current_balance: cashNote.balance,
          nonce: cashNote.nonce,
          merkle_path: merkleProof.path,
          merkle_path_indices: merkleProof.pathIndices,
          share_remainder: shareRemainder,
          owner_address: address,
          merkle_root: merkleRoot,
          nullifier: nullifierHex,
          new_commitment: newCommitment,
          bet_amount: stake,
          price: priceScaled,
          expected_shares: shares,
          market_id: safeConditionId,
          outcome_side: side === 'YES' ? 0 : 1,
          position_id: positionId,
        },
      })

      const relayInputs = {
        merkle_root: merkleRoot,
        nullifier: nullifierHex,
        new_commitment: newCommitment,
        bet_amount: stake.toString(),
        price: priceScaled.toString(),
        expected_shares: shares.toString(),
        market_id: safeConditionId,
        outcome_side: side === 'YES' ? 0 : 1,
        position_id: positionId,
      }

      log('bet_modal_relay_start', {
        marketId,
        marketName,
        ...proofSummary(proof),
        stake: stake.toString(),
        orderType,
      })

      // FC-4: register the limit-order intent BEFORE relaying so it is stored when
      // the BetAuthorized event fires (the signing layer reads it to submit a resting
      // GTC/GTD order instead of the default FOK). Keyed by nullifier_of_bet.
      if (orderType !== 'FOK') {
        await requestLimitOrder({
          nullifier_of_bet: nullifierHex,
          order_type: orderType,
          expiration: orderType === 'GTD' ? gtdMinutes * 60 : undefined,
        })
      }

      const { txHash: nextTxHash } = await relayBet(proof, relayInputs)
      setTxHash(nextTxHash)
      await waitForTransactionConfirmation(nextTxHash as `0x${string}`)

      markNoteSpent(cashNote.commitment)
      addNote({
        id: newCommitment,
        kind: 'BET_OUTPUT',
        owner_address: address,
        depositIndex: cashNote.depositIndex,
        balance: newBalance,
        nonce: newNonce,
        commitment: newCommitment,
        nullifier: newNullifier,
        spent: false,
        createdAt: Date.now(),
        txHash: nextTxHash,
        side,
      })
      addNote({
        id: `receipt-${nullifierHex}`,
        kind: 'BET_RECEIPT',
        owner_address: address,
        depositIndex: cashNote.depositIndex,
        balance: stake,
        nonce: cashNote.nonce,
        commitment: `receipt-${nullifierHex}` as `0x${string}`,
        nullifier: nullifierHex,
        nullifier_of_bet: nullifierHex,
        position_id: positionId as `0x${string}`,
        marketId,
        condition_id: safeConditionId as `0x${string}`,
        raw_condition_id: conditionId,
        bet_amount: stake,
        expectedShares: shares,
        spent: false,
        createdAt: Date.now(),
        txHash: nextTxHash,
        side,
      })
      recordWalletActivity({
        id: `bet-${nextTxHash}`,
        wallet: address,
        kind: 'bet',
        amount: stake,
        createdAt: Date.now(),
        txHash: nextTxHash,
        marketId: conditionId,
        side,
        receiptId: `receipt-${nullifierHex}`,
        receiptNullifier: nullifierHex,
      })

      setPhase('success')
      void onSuccess?.()
      log('bet_modal_success', { txHash: nextTxHash, marketId, marketName, side, stake: stake.toString() })

      window.setTimeout(() => {
        onClose()
      }, 10_000)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[BetModal] submit failed:', err)
      // FINDING: FUNC-001 — on a proof timeout (prover.ts rejects with "Proof
      // generation timed out after 3 minutes"), point the user at a more capable
      // device instead of surfacing the raw timer message.
      const isTimeout = /timed out/i.test(message)
      setError(
        isTimeout
          ? 'Proof generation is taking too long on this device. Try again on a more powerful device (desktop with more RAM).'
          : message,
      )
      setPhase('error')
      log('bet_modal_error', { error: message, marketId, marketName })
    }
  }

  const closeSafely = () => {
    if (phase === 'running') return
    onClose()
  }

  return (
      <Modal open={open} title="Confirm bet" eyebrow="BET AUTH" onClose={closeSafely} width={720}>
      {phase === 'edit' && (
        <div className="col gap-4">
          <div className="panel" style={{ padding: 16 }}>
            <KV l="Market" v={marketName} />
            <KV l="Side" v={side} />
            <KV l="Amount" v={`$${formatUsdc(amountMicro ?? 0n)} USDC`} />
            <KV l="Estimated shares" v={shares.toString()} />
            <KV l="Estimated cost" v={`$${formatUsdc(amountMicro ?? 0n)} USDC`} />
            <KV l="Protocol fee" v="~$0.00" />
          </div>
          <div>
            <div className="micro">AMOUNT (USDC)</div>
            <div className="row mt-2" style={{ gap: 8 }}>
              <input
                value={amountInput}
                onChange={(event) => setAmountInput(event.target.value)}
                placeholder="0.00"
                aria-label="Bet amount in USDC"
                style={{
                  flex: 1,
                  background: 'var(--bg-1)',
                  border: '1px solid var(--line-strong)',
                  borderRadius: 6,
                  padding: '12px 14px',
                  color: 'var(--text)',
                  fontFamily: 'var(--mono)',
                  fontSize: 15,
                }}
              />
              <button className="btn" onClick={() => setAmountInput(formatUsdcInput(BigInt(initialAmount) * 1_000_000n))}>
                Reset
              </button>
            </div>
          </div>
          <div className="col gap-2">
            <div className="row gap-2" style={{ alignItems: 'center' }}>
              <div className="micro">ORDER TYPE</div>
              <span className="pill pill-soft" style={{ fontSize: 9 }}>ADVANCED</span>
            </div>
            <div className="row" style={{ gap: 8 }}>
              {(['FOK', 'FAK', 'GTC', 'GTD'] as OrderType[]).map((t) => (
                <button
                  key={t}
                  className={`btn btn-sm ${orderType === t ? 'btn-primary' : ''}`}
                  onClick={() => setOrderType(t)}
                  type="button"
                >
                  {t === 'FOK'
                    ? 'Fill-or-kill'
                    : t === 'FAK'
                      ? 'Fill-and-kill'
                      : t === 'GTC'
                        ? 'Limit (GTC)'
                        : 'Limit (GTD)'}
                </button>
              ))}
            </div>
            {(orderType === 'GTC' || orderType === 'GTD') && (
              <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                <label className="col gap-1">
                  <span className="micro">LIMIT PRICE (¢ per share, 1–99)</span>
                  <input
                    type="number" min={1} max={99} value={limitCents}
                    onChange={(e) => setLimitCents(Math.max(1, Math.min(99, Number(e.target.value) || 1)))}
                    className="input" style={{ width: 140 }}
                  />
                </label>
                {orderType === 'GTD' && (
                  <label className="col gap-1">
                    <span className="micro">EXPIRES IN (MINUTES)</span>
                    <input
                      type="number" min={1} value={gtdMinutes}
                      onChange={(e) => setGtdMinutes(Math.max(1, Number(e.target.value) || 1))}
                      className="input" style={{ width: 140 }}
                    />
                  </label>
                )}
                <div className="small" style={{ fontSize: 11, color: 'var(--text-3)', alignSelf: 'flex-end' }}>
                  Rests on the book; the full stake is held until it fills, expires, or partially fills (then reclaim the remainder).
                </div>
              </div>
            )}
            {orderType === 'FAK' && (
              <div className="small" style={{ fontSize: 11, color: 'var(--text-3)' }}>
                Fills immediately at the market price for whatever size is available and kills the rest. If it fills only
                partially, reclaim the unfilled remainder of your stake afterward.
              </div>
            )}
          </div>
          <label className="row gap-3" style={{ alignItems: 'flex-start', cursor: 'not-allowed', opacity: 0.5 }}>
            <input
              type="checkbox"
              checked={false}
              disabled
              style={{ marginTop: 3 }}
            />
            <div>
              <div style={{ fontSize: 13 }}>Auto-settle <span className="pill pill-soft" style={{ fontSize: 9, verticalAlign: 'middle' }}>COMING SOON</span></div>
              <div className="small" style={{ fontSize: 11 }}>
                Polyshield will claim winnings automatically when this market resolves. Settle manually from Portfolio for now.
              </div>
            </div>
          </label>
          <div className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
            <button className="btn" onClick={closeSafely}>Cancel</button>
            <button className="btn btn-primary" onClick={() => void submit()} disabled={!amountMicro || amountMicro <= 0n}>
              Confirm Bet
            </button>
          </div>
        </div>
      )}

      {phase === 'running' && (
        <div className="col gap-4">
          <div>
            <div className="micro">PROGRESS</div>
            <h3 className="h4 mt-2" style={{ margin: 0 }}>Generating proof… this can take 30s–2min. Keep this tab open.</h3>
          </div>
          <div className="panel" style={{ padding: 18 }}>
            <div className="small" style={{ fontSize: 12 }}>The proof stays in your browser until it is relayed.</div>
            <div className="mt-3" style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2 }}>
              <div style={{ height: 4, width: `${progress}%`, background: 'var(--cyan)', borderRadius: 2, transition: 'width 0.5s linear', animation: 'pulse-glow 1.2s ease-in-out infinite' }} />
            </div>
            {fallbackNote && (
              <div className="small mt-3" style={{ fontSize: 11, color: 'var(--amber)' }}>{fallbackNote}</div>
            )}
          </div>
        </div>
      )}

      {phase === 'success' && (
        <div className="col gap-4">
          <div className="row gap-3">
            <div style={{ width: 40, height: 40, borderRadius: 8, background: 'oklch(0.78 0.16 152 / 0.18)', color: 'var(--green)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon d={ICONS.check} size={18} />
            </div>
            <div>
              <div className="micro" style={{ color: 'var(--green)' }}>BET PLACED</div>
              <h3 className="h4 mt-1" style={{ margin: 0 }}>Bet placed successfully.</h3>
            </div>
          </div>
          <div className="panel" style={{ padding: 16 }}>
            <KV l="Market" v={marketName} />
            <KV l="Side" v={side} />
            <KV l="Amount" v={`$${formatUsdc(amountMicro ?? 0n)} USDC`} />
            <KV l="Auto-settle" v={autoSettle ? 'Enabled' : 'Disabled'} />
            <KV l="Tx" v={txHash ? `${txHash.slice(0, 10)}…${txHash.slice(-8)}` : '—'} />
          </div>
          <div className="small" style={{ fontSize: 11, color: 'var(--text-2)' }}>
            This modal will close automatically after 10 seconds.
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div className="col gap-4">
          <div>
            <div className="micro" style={{ color: 'var(--red)' }}>BET ERROR</div>
            <h3 className="h4 mt-2" style={{ margin: 0 }}>Bet placement failed.</h3>
            {error && <p className="body mt-3" style={{ marginBottom: 0 }}>{error}</p>}
          </div>
          <div className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
            <button className="btn" onClick={closeSafely}>Close</button>
            <button className="btn btn-primary" onClick={() => void submit()}>Retry</button>
          </div>
        </div>
      )}
    </Modal>
  )
}
