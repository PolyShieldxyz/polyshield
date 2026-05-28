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
  toFieldSafe,
  type Note,
} from '@/lib/notes'
import { fetchMerklePath, relayBet, waitForTransactionConfirmation } from '@/lib/api'
import { generateProofInWorker } from '@/lib/prover'
import { log, proofSummary } from '@/lib/logger'

type Phase = 'edit' | 'running' | 'success' | 'error'
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

  useEffect(() => {
    if (!open) return
    setAmountInput(formatUsdcInput(BigInt(initialAmount) * 1_000_000n))
    setPhase('edit')
    setError(null)
    setTxHash('')
    setAutoSettle(true)
  }, [open, initialAmount, marketId])

  const amountMicro = useMemo(() => parseUsdcToMicro(amountInput), [amountInput])
  const shares = useMemo(() => {
    if (!amountMicro || price <= 0) return 0n
    return (amountMicro * 100_000_000n) / BigInt(Math.round(price * 100_000_000))
  }, [amountMicro, price])

  const submit = async () => {
    if (!address || !amountMicro || amountMicro <= 0n) return
    const cashNote = getCurrentCashNote(address)
    if (!cashNote) {
      const msg = 'No available cash balance to place this bet. Deposit USDC first.'
      console.error('[BetModal] submit: no spendable note found for', address)
      setPhase('error')
      setError(msg)
      return
    }
    if (amountMicro > cashNote.balance) {
      const msg = `Bet amount exceeds available cash balance.`
      console.error('[BetModal] submit: amount exceeds balance', { amount: amountMicro, balance: cashNote.balance })
      setPhase('error')
      setError(msg)
      return
    }

    setPhase('running')
    setError(null)
    setTxHash('')

    try {
      const stake = amountMicro
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
      const priceScaled = BigInt(Math.round(price * 100_000_000))
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
      })

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
      setError(message)
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
            <h3 className="h4 mt-2" style={{ margin: 0 }}>Generating proof... ~2 seconds</h3>
          </div>
          <div className="panel" style={{ padding: 18 }}>
            <div className="small" style={{ fontSize: 12 }}>The proof stays in your browser until it is relayed.</div>
            <div className="mt-3" style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2 }}>
              <div style={{ height: 4, width: '72%', background: 'var(--cyan)', borderRadius: 2, animation: 'pulse-glow 1.2s ease-in-out infinite' }} />
            </div>
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
