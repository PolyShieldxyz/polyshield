'use client'

import { useEffect, useState } from 'react'
import { useSignMessage } from 'wagmi'
import { Modal } from '@/components/app/Modal'
import { KV } from '@/components/app/KV'
import { LiveRegion } from '@/components/app/LiveRegion'
import { formatUsdc } from '@/lib/notes'
import {
  settleCloseAndWithdraw,
  type SettleCloseProgress,
  type SettleCloseResult,
} from '@/lib/settleCloseAndWithdraw'

type Phase = 'confirm' | 'running' | 'done'

interface SettleWithdrawModalProps {
  open: boolean
  address: `0x${string}`
  vaultAddress: `0x${string}`
  /** Counts for the confirmation summary (display only). */
  openCount: number
  readyCount: number
  onClose: () => void
  onComplete: () => Promise<void> | void
}

const PHASE_LABEL: Record<SettleCloseProgress['phase'], string> = {
  settling: 'SETTLING RESOLVED BETS',
  reclaiming: 'RECLAIMING UNFILLED ORDERS',
  closing: 'CLOSING OPEN POSITIONS',
  withdrawing: 'WITHDRAWING YOUR BALANCE',
  done: 'DONE',
}

/**
 * Option D — "Settle & Withdraw": one confirmation, then force-close everything and withdraw the full
 * balance via settleCloseAndWithdraw(). Best-effort: positions that can't be finalized in time are left
 * open (never stranded) and reported in the summary.
 */
export function SettleWithdrawModal({
  open,
  address,
  vaultAddress,
  openCount,
  readyCount,
  onClose,
  onComplete,
}: SettleWithdrawModalProps) {
  const { signMessageAsync } = useSignMessage()
  const [phase, setPhase] = useState<Phase>('confirm')
  const [progress, setProgress] = useState<SettleCloseProgress | null>(null)
  const [result, setResult] = useState<SettleCloseResult | null>(null)

  useEffect(() => {
    if (!open) return
    setPhase('confirm')
    setProgress(null)
    setResult(null)
    void import('@/lib/prover').then(({ initProver }) => initProver())
  }, [open])

  const run = async () => {
    setPhase('running')
    try {
      const res = await settleCloseAndWithdraw(address, vaultAddress, signMessageAsync, (p) => setProgress(p))
      setResult(res)
    } catch (e) {
      setResult({
        withdrawnAmount: 0n,
        settled: 0,
        closed: 0,
        reclaimed: 0,
        skipped: [],
        errors: [{ receipt: null, error: e instanceof Error ? e.message : String(e) }],
      })
    }
    setPhase('done')
  }

  const closeSafely = () => {
    if (phase === 'running') return
    if (phase === 'done') void onComplete()
    onClose()
  }

  const pct = progress ? Math.round((progress.done / Math.max(progress.total, 1)) * 100) : 0
  const leftOpen = result ? result.skipped.length + result.errors.length : 0
  const announce =
    phase === 'running'
      ? progress?.message ?? 'Working…'
      : phase === 'done'
        ? `Done. $${formatUsdc(result?.withdrawnAmount ?? 0n)} withdrawn to your wallet.`
        : ''

  return (
    <Modal open={open} title="Settle & Withdraw everything" onClose={closeSafely}>
      <LiveRegion message={announce} />

      {phase === 'confirm' && (
        <div className="col gap-4">
          <p className="body" style={{ margin: 0 }}>
            This will, in one flow: <strong>settle</strong> every resolved bet, <strong>sell every open
            position at the current market price</strong> (realizing gains or losses now), reclaim any
            unfilled or resting orders, and <strong>withdraw your full balance</strong> to your wallet.
          </p>
          <div className="panel" style={{ padding: 16 }}>
            <KV l="Resolved bets to settle" v={String(readyCount)} />
            <KV l="Open positions to close / reclaim" v={String(openCount)} />
            <KV l="Destination" v="Your connected wallet" />
          </div>
          <p className="small" style={{ margin: 0, color: 'var(--text-3)' }}>
            Selling at market incurs the Polymarket taker fee and may fill below a position&apos;s
            resolution value. Anything that can&apos;t be finalized in time is left open and reported —
            its funds stay safe and you can settle or close it later.
          </p>
          <div className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
            <button className="btn" onClick={closeSafely}>Cancel</button>
            <button className="btn btn-primary" onClick={() => void run()}>Settle, close &amp; withdraw</button>
          </div>
        </div>
      )}

      {phase === 'running' && (
        <div className="col gap-4">
          <div>
            <div className="micro">{progress ? PHASE_LABEL[progress.phase] : 'WORKING'}</div>
            <h3 className="h4 mt-2" style={{ margin: 0 }}>{progress?.message ?? 'Working…'}</h3>
          </div>
          <div className="panel" style={{ padding: 18 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="small">Generating proofs and confirming on-chain. Keep this tab open.</span>
              <span className="mono" style={{ fontSize: 12 }}>{pct}%</span>
            </div>
            <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, marginTop: 10 }}>
              <div style={{ height: 4, width: `${pct}%`, background: 'var(--cyan)', borderRadius: 2, transition: 'width 0.35s ease' }} />
            </div>
          </div>
        </div>
      )}

      {phase === 'done' && result && (
        <div className="col gap-4">
          <div className="micro" style={{ color: 'var(--green)' }}>DONE</div>
          <h3 className="h4" style={{ margin: 0 }}>+${formatUsdc(result.withdrawnAmount)} withdrawn to your wallet.</h3>
          <div className="panel" style={{ padding: 16 }}>
            <KV l="Settled" v={String(result.settled)} />
            <KV l="Closed" v={String(result.closed)} />
            <KV l="Reclaimed" v={String(result.reclaimed)} />
            <KV l="Withdrawn" v={`$${formatUsdc(result.withdrawnAmount)} USDC`} />
          </div>
          {leftOpen > 0 && (
            <div className="panel" style={{ padding: 16, borderColor: 'var(--amber)' }}>
              <div className="micro" style={{ color: 'var(--amber)' }}>LEFT OPEN</div>
              <p className="small mt-2" style={{ margin: 0 }}>
                {leftOpen} position{leftOpen === 1 ? '' : 's'} couldn&apos;t be finalized right now (still
                working or pending) and {leftOpen === 1 ? 'was' : 'were'} left open. {leftOpen === 1 ? 'It keeps' : 'They keep'} {leftOpen === 1 ? 'its' : 'their'} funds
                safe — settle or close later, or run this again.
              </p>
            </div>
          )}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" onClick={closeSafely}>Done</button>
          </div>
        </div>
      )}
    </Modal>
  )
}
