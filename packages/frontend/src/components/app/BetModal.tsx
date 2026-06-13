'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAccount, useSignMessage, useReadContract } from 'wagmi'
import { VAULT_ABI } from '@/lib/vaultAbi'
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
  getFreeNotes,
  markNoteSpent,
  MAX_CONSOLIDATE_INPUTS,
  positionToField,
  reconcileSpentStatus,
  recordWalletActivity,
  selectNotesForAmount,
  toFieldSafe,
  type Note,
} from '@/lib/notes'
import { consolidateNotes } from '@/lib/consolidate'
import { fetchMerklePath, relayBet, requestLimitOrder, waitForTransactionConfirmation } from '@/lib/api'
import { generateProofInWorker } from '@/lib/prover'
import { log, proofSummary } from '@/lib/logger'
import { marketBuyCeilingFromBook, roundToTick, type BookLevel } from '@/lib/pricing'
import { type OrderKind, ORDER_KIND_LABEL } from '@/lib/orderType'

type Phase = 'edit' | 'running' | 'success' | 'error'
const VAULT_ADDRESS = (process.env.NEXT_PUBLIC_VAULT_ADDRESS ??
  '0x0000000000000000000000000000000000000000') as `0x${string}`

interface BetModalProps {
  open: boolean
  marketId: string
  marketName: string
  conditionId: `0x${string}`
  side: 'YES' | 'NO'
  // Display label for the chosen side ("UP"/"DOWN" for Up/Down markets, else "YES"/"NO").
  // Display-only — `side` still drives the circuit's outcome_side (0/1).
  sideLabel?: string
  initialAmount: number
  price: number
  // L1: CLOB tick size + best executable ask for the selected side (from the market payload).
  // A Market order commits a tick-snapped ceiling derived from the book depth; absent → tick 0.001.
  tickSize?: number
  bestAsk?: number
  // Executable ask ladder for the selected side (ascending), walked to derive the market ceiling.
  levels: BookLevel[]
  // Order type is chosen on the market page and passed in (read-only here).
  orderKind: OrderKind
  limitCents: number
  expiryEnabled: boolean
  gtdMinutes: number
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

// Dollars (may include cents, e.g. 2.5) → micro-USDC. initialAmount arrives as a JS number
// from the market page; BigInt(2.5) throws ("not an integer"), so round to micro first. This
// was the bug that rejected fractional bet amounts like $2.50.
function dollarsToMicro(dollars: number): bigint {
  if (!Number.isFinite(dollars) || dollars <= 0) return 0n
  return BigInt(Math.round(dollars * 1_000_000))
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
  sideLabel,
  initialAmount,
  price,
  tickSize,
  bestAsk,
  levels,
  orderKind,
  limitCents,
  expiryEnabled,
  gtdMinutes,
  onClose,
  onSuccess,
}: BetModalProps) {
  const { address } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const [amountInput, setAmountInput] = useState(formatUsdcInput(dollarsToMicro(initialAmount)))
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
  // Order type (orderKind / limitCents / expiryEnabled / gtdMinutes) is selected on the market
  // page and arrives as props; this modal only displays and submits it.

  useEffect(() => {
    if (!open) return
    setAmountInput(formatUsdcInput(dollarsToMicro(initialAmount)))
    setPhase('edit')
    setError(null)
    setTxHash('')
    setAutoSettle(true)
    setProgress(5)
    setFallbackNote(null)
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

  const amountMicro = useMemo(() => parseUsdcToMicro(amountInput), [amountInput])
  // L1: the bet_auth proof commits this price. A Market BUY commits a tick-snapped CEILING from
  // walking the book (worst price the stake would touch + slippage pad) so the executed fill is
  // at-or-better and committed expected_shares is a guaranteed MINIMUM (surplus → pool, FC-4 Q4);
  // L3 reconciliation then rarely fires. A Limit order rests at the user's tick-snapped limit price.
  const effectivePrice = useMemo(() => {
    if (orderKind === 'MARKET') {
      const notionalUsd = amountMicro ? Number(amountMicro) / 1e6 : 0
      return marketBuyCeilingFromBook(levels, notionalUsd, tickSize, bestAsk ?? price)
    }
    return roundToTick(limitCents / 100, tickSize)
  }, [orderKind, price, bestAsk, tickSize, limitCents, levels, amountMicro])
  const shares = useMemo(() => {
    if (!amountMicro || effectivePrice <= 0) return 0n
    return (amountMicro * 100_000_000n) / BigInt(Math.round(effectivePrice * 100_000_000))
  }, [amountMicro, effectivePrice])
  // Polymarket rejects orders below 5 shares ("Size lower than the minimum: 5"). shares is
  // 1e6-scaled, so the floor is 5e6. Block here so the user isn't surprised by a failed order.
  const MIN_SHARES = 5_000_000n
  const belowMinShares = shares > 0n && shares < MIN_SHARES

  // FEE: read the governance fee config so the client computes the SAME Vault-injected fee it
  // must commit to in the bet_auth proof (fee = bet_amount*betFeeBps/10000 + relayGasFeeUSDC).
  // betFeeBps (uint16) comes back as a number; the uint64 fields as bigint — coerce defensively.
  const { data: feeConfigData } = useReadContract({
    address: VAULT_ADDRESS,
    abi: VAULT_ABI,
    functionName: 'feeConfig',
    query: { enabled: VAULT_ADDRESS !== '0x0000000000000000000000000000000000000000' },
  })
  const betFeeBps = feeConfigData ? BigInt(feeConfigData[0]) : 0n
  const relayGasFeeUSDC = feeConfigData ? BigInt(feeConfigData[1]) : 0n
  const minBet = feeConfigData ? BigInt(feeConfigData[2]) : 1_000_000n // default $1 until loaded
  const fee = useMemo(() => {
    if (!amountMicro || amountMicro <= 0n) return 0n
    return (amountMicro * betFeeBps) / 10_000n + relayGasFeeUSDC
  }, [amountMicro, betFeeBps, relayGasFeeUSDC])
  const belowMinBet = amountMicro !== null && amountMicro > 0n && amountMicro < minBet

  // FEE: the spent note must cover bet_amount + fee — the bet_auth circuit computes
  // new_balance = current_balance - bet_amount - fee and range-checks it to 64 bits, so a bet
  // that would leave a negative remainder fails proof generation with an opaque underflow
  // ("Assert Failed … BetAuth line 98/100"). Guard here against the COMBINABLE balance (up to
  // MAX_CONSOLIDATE_INPUTS notes can be merged first) and surface the real max bettable amount.
  const combinableBalance = useMemo(() => {
    if (!address || !open) return 0n
    return getFreeNotes(address)
      .sort((a, b) => (a.balance > b.balance ? -1 : 1))
      .slice(0, MAX_CONSOLIDATE_INPUTS)
      .reduce((sum, n) => sum + n.balance, 0n)
  }, [address, open])
  // Largest bet whose amount + fee fits the balance: amount*(1 + betFeeBps/10000) + relayGas <= bal.
  const maxBettable = useMemo(() => {
    if (combinableBalance <= relayGasFeeUSDC) return 0n
    return ((combinableBalance - relayGasFeeUSDC) * 10_000n) / (10_000n + betFeeBps)
  }, [combinableBalance, relayGasFeeUSDC, betFeeBps])
  const exceedsBalance = amountMicro !== null && amountMicro > 0n && amountMicro > maxBettable

  const submit = async () => {
    if (!address || !amountMicro || amountMicro <= 0n) return
    // FEE: the bet fee is governance-set and Vault-injected; the client must commit to the exact
    // same value, so block until the fee config has loaded (otherwise fee would default to 0 and
    // the Vault would reject the proof) and enforce the on-chain minimum bet before proving.
    if (!feeConfigData) {
      setPhase('error')
      setError('Loading fee schedule — please try again in a moment.')
      return
    }
    if (amountMicro < minBet) {
      setPhase('error')
      setError(`Minimum bet is $${formatUsdc(minBet)} (Polymarket rejects smaller orders).`)
      return
    }
    if (shares < MIN_SHARES) {
      setPhase('error')
      setError(
        `Polymarket's minimum order is 5 shares — this bet is only ${(Number(shares) / 1e6).toFixed(2)}. ` +
        `Increase the amount (≈$${(5 * effectivePrice).toFixed(2)} or more at this price).`,
      )
      return
    }
    // Chain-authoritative spent check before selecting a note: heals any locally-stale note whose
    // nullifier is already spent on-chain, so we never pick a spent note → no NullifierSpent revert.
    await reconcileSpentStatus(address).catch(() => undefined)
    let cashNote = getCurrentCashNote(address)
    if (!cashNote) {
      const msg = 'No available cash balance to place this bet. Deposit USDC first.'
      console.error('[BetModal] submit: no spendable note found for', address)
      setPhase('error')
      setError(msg)
      return
    }
    // FEE: the note must cover bet_amount + fee (the circuit deducts both). Select/merge against
    // the full cost, not just the stake, so the merged note never underflows in the proof.
    const cost = amountMicro + fee
    if (amountMicro > maxBettable) {
      setPhase('error')
      setError(
        `This bet plus the $${formatUsdc(fee)} fee exceeds your balance. ` +
        `The most you can bet right now is $${formatUsdc(maxBettable)}.`,
      )
      return
    }
    // FC-8: a single note need not cover the cost — up to 4 notes can be merged first.
    // Reject only when even the largest 4 notes can't cover it.
    if (cost > cashNote.balance) {
      const sel = selectNotesForAmount(address, cost)
      if (!sel.ok) {
        console.error('[BetModal] submit: cost exceeds combinable balance', { cost })
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
      // FC-8: if no single note covers the bet + fee, consolidate up to 4 notes into one
      // (a merge proof + tx via the relay), then bet from the merged note.
      if (cost > cashNote.balance) {
        const sel = selectNotesForAmount(address, cost)
        if (!sel.ok) throw new Error(sel.error)
        cashNote = await consolidateNotes({
          wallet: address,
          signMessageAsync,
          notes: sel.selection.notes,
          onProgress: (m) => log('bet_modal_consolidate', { step: m }),
        })
      }
      // FEE: final guard — the spent note must cover bet_amount + fee or the circuit underflows.
      if (cashNote.balance < stake + fee) {
        throw new Error(
          `This bet plus the $${formatUsdc(fee)} fee exceeds your balance. Reduce the amount.`,
        )
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
      // FEE: deduct the bet amount AND the Vault-injected fee from the note balance — this must
      // match the circuit's new_balance = current_balance - bet_amount - fee.
      const newBalance = cashNote.balance - stake - fee
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
          fee, // FEE: Vault-injected; circuit binds new_balance = current_balance - bet_amount - fee
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
        // proof-relay validates this with NUM (z.string() decimal); send the digit as a
        // string, not a raw number, or the relay rejects the bet with "invalid inputs".
        outcome_side: side === 'YES' ? '0' : '1',
        position_id: positionId,
      }

      log('bet_modal_relay_start', {
        marketId,
        marketName,
        ...proofSummary(proof),
        stake: stake.toString(),
        orderKind,
      })

      // Register a Limit-order intent BEFORE relaying so it is stored when the BetAuthorized event
      // fires (the signing layer reads it to submit a resting GTC/GTD order). A Market order
      // registers no intent and falls through to the signing layer's default FAK route. Keyed by
      // nullifier_of_bet; expiryEnabled → GTD with the chosen lifetime, otherwise GTC.
      if (orderKind === 'LIMIT') {
        await requestLimitOrder({
          nullifier_of_bet: nullifierHex,
          order_type: expiryEnabled ? 'GTD' : 'GTC',
          expiration: expiryEnabled ? gtdMinutes * 60 : undefined,
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
      }, 3_000)
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
            <KV l="Side" v={sideLabel ?? side} />
            <KV l="Amount" v={`$${formatUsdc(amountMicro ?? 0n)} USDC`} />
            <KV l={orderKind === 'MARKET' ? 'Minimum shares' : 'Estimated shares'} v={shares.toString()} />
            <KV
              l={`Protocol fee${betFeeBps > 0n ? ` (${(Number(betFeeBps) / 100).toFixed(2)}%)` : ''}`}
              v={`$${formatUsdc(fee)} USDC`}
            />
            <KV l="Total deducted" v={`$${formatUsdc((amountMicro ?? 0n) + fee)} USDC`} />
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
              <button className="btn" onClick={() => setAmountInput(formatUsdcInput(dollarsToMicro(initialAmount)))}>
                Reset
              </button>
            </div>
            {belowMinBet && (
              <div className="small mt-1" style={{ color: 'var(--red)', fontSize: 11 }}>
                Minimum bet is ${formatUsdc(minBet)} (Polymarket rejects smaller orders).
              </div>
            )}
            {!belowMinBet && exceedsBalance && (
              <div className="small mt-1" style={{ color: 'var(--red)', fontSize: 11 }}>
                Amount + ${formatUsdc(fee)} fee exceeds your balance. Max bettable is ${formatUsdc(maxBettable)}.
              </div>
            )}
            {!belowMinBet && !exceedsBalance && belowMinShares && (
              <div className="small mt-1" style={{ color: 'var(--red)', fontSize: 11 }}>
                Polymarket minimum is 5 shares (this is {(Number(shares) / 1e6).toFixed(2)}). Bet ≈${(5 * effectivePrice).toFixed(2)}+ at this price.
              </div>
            )}
          </div>
          {/* Order type is chosen on the market page; shown here read-only for confirmation. */}
          <div className="col gap-2">
            <div className="row gap-2" style={{ alignItems: 'center' }}>
              <div className="micro">ORDER TYPE</div>
            </div>
            <div className="panel" style={{ padding: 12 }}>
              <KV l="Type" v={ORDER_KIND_LABEL[orderKind]} />
              {orderKind === 'LIMIT' && (
                <KV l="Limit price" v={`${limitCents}¢ ($${(limitCents / 100).toFixed(2)}/share)`} />
              )}
              {orderKind === 'LIMIT' && expiryEnabled && <KV l="Expires in" v={`${gtdMinutes} min`} />}
            </div>
            {orderKind === 'LIMIT' ? (
              <div className="small" style={{ fontSize: 11, color: 'var(--text-3)' }}>
                Rests on the book at your limit price; the full stake is held until it fills, {expiryEnabled ? 'expires,' : 'you cancel,'} or partially fills (then reclaim the remainder).
              </div>
            ) : (
              <div className="small" style={{ fontSize: 11, color: 'var(--text-3)' }}>
                Fills immediately at the best available price for whatever size the book offers now. If it fills only
                partially, reclaim the unfilled remainder of your stake afterward.
              </div>
            )}
            <div className="small" style={{ fontSize: 11, color: 'var(--text-3)' }}>
              Change the order type on the market page before generating the proof.
            </div>
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
            <button className="btn btn-primary" onClick={() => void submit()} disabled={!amountMicro || amountMicro <= 0n || belowMinBet || exceedsBalance || belowMinShares}>
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
            <KV l="Side" v={sideLabel ?? side} />
            <KV l="Amount" v={`$${formatUsdc(amountMicro ?? 0n)} USDC`} />
            <KV l="Auto-settle" v={autoSettle ? 'Enabled' : 'Disabled'} />
            <KV l="Tx" v={txHash ? `${txHash.slice(0, 10)}…${txHash.slice(-8)}` : '—'} />
          </div>
          <div className="small" style={{ fontSize: 11, color: 'var(--text-2)' }}>
            This modal will close automatically after 3 seconds.
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
