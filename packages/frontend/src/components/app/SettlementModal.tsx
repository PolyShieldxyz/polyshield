'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSignMessage } from 'wagmi'
import { Modal } from '@/components/app/Modal'
import { KV } from '@/components/app/KV'
import { LiveRegion } from '@/components/app/LiveRegion'
import { Icon, ICONS } from '@/components/ui/Icon'
import { formatUsdc, type Note, type ReadyToSettleBet } from '@/lib/notes'
import { settlePosition } from '@/lib/settlePosition'
import { log } from '@/lib/logger'

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

const VAULT_ADDRESS = (process.env.NEXT_PUBLIC_VAULT_ADDRESS ?? '0x0000000000000000000000000000000000000000') as `0x${string}`

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
    // Run ONLY when the modal opens — NOT when readyBets changes. readyBets gets a fresh array
    // reference on every 15–60s portfolio poll; including it here reset the modal to 'select'
    // mid-proof-generation (wiping the "generating proof" UI and overwriting any 'error' before it
    // could be seen) — i.e. the settle flow "disappeared with no error".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

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

    const applied: ReadyToSettleBet[] = [...previouslyCompleted]

    try {
      for (let i = 0; i < betsToProcess.length; i++) {
        const bet = betsToProcess[i]
        log('settle_batch_item_start', {
          marketId: bet.receipt.marketId,
          receiptId: bet.receipt.id,
          sequence: previouslyCompleted.length + i + 1,
          totalSelected: selectedBets.length,
          claimAmount: bet.claimAmount.toString(),
        })

        // settlePosition resolves THIS bet's lineage tip itself (correct per-deposit secret), proves +
        // relays the settlement, and advances the note cache — so a multi-lineage batch and sequential
        // same-lineage settles both work without tracking the tip here.
        const res = await settlePosition(address, bet, VAULT_ADDRESS, signMessageAsync)
        if (!res.done) {
          throw new Error('No spendable note is available in this deposit to receive the settlement credit.')
        }

        applied.push(bet)
        setCompleted([...applied])
        if (res.nextNote) setLastCreditNote(res.nextNote)
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

  // WCAG 4.1.3 — announce the long settlement run + result to assistive tech (otherwise silent).
  const announce =
    phase === 'running'
      ? `Settling bet ${progressIndex + 1} of ${selectedBets.length}. Generating proof and waiting for on-chain confirmation.`
      : phase === 'done'
        ? (isCloseLosses
            ? `Closed ${completed.length} position${completed.length === 1 ? '' : 's'}.`
            : `Settled ${completed.length} bet${completed.length === 1 ? '' : 's'}. $${formatUsdc(totalCredit)} added to your balance.`)
        : phase === 'error'
          ? error ?? 'Settlement failed.'
          : ''

  return (
    <Modal open={open} title={isCloseLosses ? 'Close lost positions' : 'Settle resolved bets'} onClose={closeSafely}>
      <LiveRegion message={announce} assertive={phase === 'error'} />
      {phase === 'select' && (
        <div className="col gap-4">
          <p className="body" style={{ margin: 0 }}>
            {isCloseLosses
              ? 'Generate a zero-credit settlement proof for each lost bet. This formally closes the position on-chain so your note nonce stays consistent.'
              : 'Select one or more resolved bets. PolyShield will generate one proof per bet and relay them sequentially so your balance stays in sync.'}
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
                    background: checked ? 'oklch(0.82 0.13 85 / 0.06)' : 'var(--surface)',
                    borderColor: checked ? 'oklch(0.82 0.13 85 / 0.35)' : 'var(--line)',
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
                          background: checked ? 'oklch(0.82 0.13 85 / 0.2)' : 'transparent',
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
