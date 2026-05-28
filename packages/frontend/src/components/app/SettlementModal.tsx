'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSignMessage } from 'wagmi'
import { Modal } from '@/components/app/Modal'
import { KV } from '@/components/app/KV'
import { Icon, ICONS } from '@/components/ui/Icon'
import {
  addNote,
  computeCommitment,
  computeNullifier,
  deriveSecret,
  formatUsdc,
  getCurrentCashNote,
  markBetReceiptSpent,
  markNoteSpent,
  recordWalletActivity,
  type Note,
  type ReadyToSettleBet,
} from '@/lib/notes'
import {
  fetchMerklePath,
  relaySettlement,
  waitForTransactionConfirmation,
} from '@/lib/api'
import { generateSettlementProof } from '@/lib/prover'
import { log, proofSummary } from '@/lib/logger'

type Phase = 'select' | 'running' | 'done' | 'error'

interface SettlementModalProps {
  open: boolean
  address: `0x${string}`
  readyBets: ReadyToSettleBet[]
  /** 'close-losses': zero-credit settlement to formally close lost positions on-chain */
  mode?: 'settle' | 'close-losses'
  onClose: () => void
  onComplete: () => Promise<void> | void
}

const ZERO_BYTES32 = `0x${'00'.repeat(32)}` as `0x${string}`

export function SettlementModal({
  open,
  address,
  readyBets,
  mode = 'settle',
  onClose,
  onComplete,
}: SettlementModalProps) {
  const isCloseLosses = mode === 'close-losses'
  const { signMessageAsync } = useSignMessage()
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [phase, setPhase] = useState<Phase>('select')
  const [progressIndex, setProgressIndex] = useState(0)
  const [completed, setCompleted] = useState<ReadyToSettleBet[]>([])
  const [lastCreditNote, setLastCreditNote] = useState<Note | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setSelectedIds(readyBets.map((bet) => bet.receipt.id))
    setPhase('select')
    setProgressIndex(0)
    setCompleted([])
    setLastCreditNote(null)
    setError(null)
    void import('@/lib/prover').then(({ initProver }) => initProver())
  }, [open, readyBets])

  useEffect(() => {
    if (phase !== 'done') return
    const id = window.setTimeout(() => {
      void onComplete()
      onClose()
    }, 5_000)
    return () => window.clearTimeout(id)
  }, [phase, onClose, onComplete])

  const selectedBets = useMemo(
    () => readyBets.filter((bet) => selectedIds.includes(bet.receipt.id)),
    [readyBets, selectedIds],
  )
  const completedIdSet = useMemo(
    () => new Set(completed.map((bet) => bet.receipt.id)),
    [completed],
  )

  const totalCredit = selectedBets.reduce((sum, bet) => sum + bet.claimAmount, 0n)

  const toggle = (id: string) => {
    if (phase === 'running') return
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    )
  }

  const runSettlement = async () => {
    const previouslyCompleted = phase === 'error' ? completed : []
    const previouslyCompletedIds = new Set(previouslyCompleted.map((bet) => bet.receipt.id))
    const betsToProcess = selectedBets.filter((bet) => !previouslyCompletedIds.has(bet.receipt.id))
    if (selectedBets.length === 0) return
    if (betsToProcess.length === 0) {
      setPhase('done')
      return
    }

    setCompleted([...previouslyCompleted])
    setPhase('running')
    setProgressIndex(previouslyCompleted.length)
    setError(null)

    let currentFreeNote = getCurrentCashNote(address)
    if (!currentFreeNote) {
      setPhase('error')
      setError('No cash balance is available to receive settlement credit.')
      return
    }

    const applied: ReadyToSettleBet[] = [...previouslyCompleted]

    try {
      for (let i = 0; i < betsToProcess.length; i++) {
        const bet = betsToProcess[i]
        const receipt = bet.receipt
        const secret = await deriveSecret(signMessageAsync, address, currentFreeNote.depositIndex)
        const merkle = await fetchMerklePath(currentFreeNote.commitment)
        const marketIdField = receipt.condition_id ?? ZERO_BYTES32
        const newNonce = currentFreeNote.nonce + 1n
        const newBalance = currentFreeNote.balance + bet.claimAmount
        const newCommitment = computeCommitment(secret, newBalance, newNonce, address)
        const newNullifier = computeNullifier(secret, newNonce)
        const nullifierOfBet = receipt.nullifier_of_bet ?? receipt.nullifier

        log('settle_batch_item_start', {
          marketId: receipt.marketId,
          receiptId: receipt.id,
          sequence: previouslyCompleted.length + i + 1,
          totalSelected: selectedBets.length,
          claimAmount: bet.claimAmount.toString(),
        })

        const { proof } = await generateSettlementProof({
          secret,
          balance_before_credit: currentFreeNote.balance,
          nonce: currentFreeNote.nonce,
          merkle_path: merkle.path,
          merkle_path_indices: merkle.pathIndices,
          owner_address: address,
          merkle_root: merkle.root,
          nullifier: currentFreeNote.nullifier,
          new_commitment: newCommitment,
          nullifier_of_bet: nullifierOfBet,
          market_id: marketIdField,
          total_credit: bet.claimAmount,
        })

        const inputs = {
          merkle_root: merkle.root,
          nullifier: currentFreeNote.nullifier,
          new_commitment: newCommitment,
          nullifier_of_bet: nullifierOfBet,
          market_id: marketIdField,
          total_credit: bet.claimAmount.toString(),
        }

        log('settle_relay_start', {
          ...proofSummary(proof),
          inputs: { ...inputs },
          receiptId: receipt.id,
          marketId: receipt.marketId,
        })

        const { txHash } = await relaySettlement(proof, inputs)
        await waitForTransactionConfirmation(txHash as `0x${string}`)

        markNoteSpent(currentFreeNote.commitment)
        markBetReceiptSpent(nullifierOfBet)
        recordWalletActivity({
          id: `settlement-${txHash}-${bet.receipt.id}`,
          wallet: address,
          kind: 'settlement',
          amount: bet.claimAmount,
          createdAt: Date.now(),
          txHash,
          marketId: receipt.marketId as `0x${string}` | undefined,
          receiptId: bet.receipt.id,
          receiptNullifier: nullifierOfBet as `0x${string}`,
          payout: bet.claimAmount,
        })

        const nextFreeNote: Note = {
          id: newCommitment,
          kind: 'SETTLE_CREDIT',
          owner_address: address,
          depositIndex: currentFreeNote.depositIndex,
          balance: newBalance,
          nonce: newNonce,
          commitment: newCommitment,
          nullifier: newNullifier,
          spent: false,
          createdAt: Date.now(),
          txHash,
          marketId: receipt.marketId,
          condition_id: marketIdField,
        }
        addNote(nextFreeNote)

        currentFreeNote = nextFreeNote
        applied.push(bet)
        setCompleted([...applied])
        setLastCreditNote(nextFreeNote)
        setProgressIndex(previouslyCompleted.length + i + 1)
      }

      setPhase('done')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setCompleted([...applied])
      setPhase('error')
    }
  }

  const closeSafely = () => {
    if (phase === 'running') return
    if (completed.length > 0) {
      void onComplete()
    }
    onClose()
  }

  return (
    <Modal open={open} title={isCloseLosses ? 'Close lost positions' : 'Settle resolved bets'} onClose={closeSafely}>
      {phase === 'select' && (
        <div className="col gap-4">
          <p className="body" style={{ margin: 0 }}>
            {isCloseLosses
              ? 'Generate a zero-credit settlement proof for each lost bet. This formally closes the position on-chain so your note nonce stays consistent.'
              : 'Select one or more resolved bets. Polyshield will generate one proof per bet and relay them sequentially so your balance stays in sync.'}
          </p>
          <div className="col gap-2">
            {readyBets.length === 0 && (
              <div className="panel" style={{ padding: 18, color: 'var(--text-2)', fontSize: 13 }}>
                No resolved bets are ready to settle yet.
              </div>
            )}
            {readyBets.map((bet) => {
              const checked = selectedIds.includes(bet.receipt.id)
              return (
                <button
                  key={bet.receipt.id}
                  className="panel"
                  onClick={() => toggle(bet.receipt.id)}
                  style={{
                    padding: 16,
                    textAlign: 'left',
                    background: checked ? 'oklch(0.82 0.13 210 / 0.06)' : 'var(--surface)',
                    borderColor: checked ? 'oklch(0.82 0.13 210 / 0.35)' : 'var(--line)',
                  }}
                >
                  <div className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
                    <div className="row gap-3">
                      <span
                        style={{
                          width: 16,
                          height: 16,
                          borderRadius: 3,
                          border: '1px solid',
                          borderColor: checked ? 'var(--cyan)' : 'var(--line-strong)',
                          background: checked ? 'oklch(0.82 0.13 210 / 0.2)' : 'transparent',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        {checked && <Icon d={ICONS.check} size={11} className="text-cyan" />}
                      </span>
                      <div>
                        <div style={{ fontSize: 14, color: 'var(--text)' }}>
                          {bet.receipt.marketId ?? bet.receipt.id}
                        </div>
                        <div className="small mt-1" style={{ fontSize: 11 }}>
                          Stake ${formatUsdc(bet.receipt.bet_amount ?? bet.receipt.balance)} · payout/share {bet.payoutPerShare.toString()}
                        </div>
                      </div>
                    </div>
                    <div className="num" style={{ color: isCloseLosses ? 'var(--red)' : 'var(--green)', fontSize: 16 }}>
                      {isCloseLosses ? `−$${formatUsdc(bet.receipt.bet_amount ?? bet.receipt.balance)}` : `+$${formatUsdc(bet.claimAmount)}`}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
          <div className="panel" style={{ padding: 16 }}>
            <KV l="Selected bets" v={String(selectedBets.length)} />
            <KV l={isCloseLosses ? 'Positions to close' : 'Credit to add'} v={isCloseLosses ? String(selectedBets.length) : `$${formatUsdc(totalCredit)} USDC`} />
          </div>
          <div className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
            <button className="btn" onClick={closeSafely}>Cancel</button>
            <button
              className="btn btn-primary"
              onClick={() => void runSettlement()}
              disabled={selectedBets.length === 0}
              style={{ opacity: selectedBets.length === 0 ? 0.5 : 1 }}
            >
              {isCloseLosses ? 'Close Positions' : 'Confirm Settlement'}
            </button>
          </div>
        </div>
      )}

      {phase === 'running' && (
        <div className="col gap-4">
          <div>
            <div className="micro">PROGRESS</div>
            <h3 className="h4 mt-2" style={{ margin: 0 }}>
              Settling {selectedBets.length} bets... ({progressIndex} of {selectedBets.length} complete)
            </h3>
          </div>
          <div className="panel" style={{ padding: 18 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="small">Generating proof and waiting for on-chain confirmation before the next bet.</span>
              <span className="mono" style={{ fontSize: 12 }}>
                {Math.round((progressIndex / Math.max(selectedBets.length, 1)) * 100)}%
              </span>
            </div>
            <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, marginTop: 10 }}>
              <div
                style={{
                  height: 4,
                  width: `${(progressIndex / Math.max(selectedBets.length, 1)) * 100}%`,
                  background: 'var(--cyan)',
                  borderRadius: 2,
                  transition: 'width 0.35s ease',
                }}
              />
            </div>
          </div>
        </div>
      )}

      {phase === 'done' && (
        <div className="col gap-4">
          <div className="row gap-3">
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 8,
                background: 'oklch(0.78 0.16 152 / 0.18)',
                color: 'var(--green)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon d={ICONS.check} size={18} />
            </div>
            <div>
              <div className="micro" style={{ color: 'var(--green)' }}>SETTLED</div>
              <h3 className="h4 mt-1" style={{ margin: 0 }}>
                {isCloseLosses
                  ? `Closed ${completed.length} lost position${completed.length === 1 ? '' : 's'}.`
                  : `Settled ${completed.length} bets. +$${formatUsdc(totalCredit)} added to your balance.`}
              </h3>
            </div>
          </div>
          {lastCreditNote && (
            <div className="panel" style={{ padding: 16 }}>
              <KV l="Updated cash balance" v={`$${formatUsdc(lastCreditNote.balance)} USDC`} />
              <KV l="Auto close" v="5 seconds" />
            </div>
          )}
        </div>
      )}

      {phase === 'error' && (
        <div className="col gap-4">
          <div>
            <div className="micro" style={{ color: 'var(--red)' }}>SETTLEMENT ERROR</div>
            <h3 className="h4 mt-2" style={{ margin: 0 }}>
              {completed.length > 0
                ? `Settled ${completed.length} bet${completed.length === 1 ? '' : 's'} before the flow stopped.`
                : 'No settlements were completed.'}
            </h3>
            {error && <p className="body mt-3" style={{ marginBottom: 0 }}>{error}</p>}
          </div>
          <div className="panel" style={{ padding: 16 }}>
            <KV l="Completed" v={String(completed.length)} />
            <KV l="Remaining" v={String(selectedBets.length - completedIdSet.size)} />
            <KV
              l="Applied credit"
              v={`$${formatUsdc(completed.reduce((sum, bet) => sum + bet.claimAmount, 0n))} USDC`}
            />
          </div>
          <div className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
            <button className="btn" onClick={closeSafely}>Close</button>
            <button className="btn btn-primary" onClick={() => void runSettlement()}>
              Retry remaining bets
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}
