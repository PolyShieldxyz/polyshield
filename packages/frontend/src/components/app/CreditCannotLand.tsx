'use client'

import { TWITTER_URL } from '@/lib/brand'

/**
 * H3 fix — shared dead-end screen for the credit/close paths.
 *
 * Every credit path (settlement, partial-fill, bet-cancel, position-close) needs a *free* note in
 * the same deposit lineage to receive the credit. When none is in the local cache, the old modals
 * dropped to a raw error + a generic "Retry" that re-failed identically. This component replaces
 * that branch with a clear, recoverable screen:
 *
 *  - reason 'no-free-note'  → the change-note for this deposit just isn't in the local cache yet.
 *    Primary action is "Restore from chain" (re-derives notes from the wallet) — NOT Retry.
 *  - reason 'fully-spent' / 'structural' → not self-recoverable. Surface a support CTA + the
 *    operator/admin-escape-hatch note. NO Retry.
 *
 * In all cases the funds are SAFE in the vault — this is a local-cache / structural gap, never a loss.
 */
export type CreditCannotLandReason = 'no-free-note' | 'fully-spent' | 'structural'

interface CreditCannotLandProps {
  reason: CreditCannotLandReason
  /** Optional raw detail (e.g. the original error message) shown as a small monospace footnote. */
  detail?: string
  /** Restore-from-chain handler (required in practice for reason 'no-free-note'). */
  onRestore?: () => void
  /** Spinner state for the Restore button. */
  restoring?: boolean
  /** Support/contact link for the non-recoverable cases. Defaults to the public X/Twitter account. */
  supportHref?: string
  onClose: () => void
}

export function CreditCannotLand({
  reason,
  detail,
  onRestore,
  restoring = false,
  supportHref,
  onClose,
}: CreditCannotLandProps) {
  const isNoFreeNote = reason === 'no-free-note'
  const isStructural = reason === 'structural'
  const heading = isStructural
    ? 'This position can’t be closed automatically'
    : 'This credit can’t land yet'
  const href = supportHref ?? TWITTER_URL

  return (
    <div className="col gap-4">
      <div>
        <div className="micro" style={{ color: 'var(--amber)' }}>
          {isStructural ? 'CAN’T CLOSE YET' : 'CREDIT PENDING'}
        </div>
        <h3 className="h4 mt-2" style={{ margin: 0 }}>{heading}</h3>
      </div>

      <p className="body" style={{ margin: 0 }}>
        {isNoFreeNote ? (
          <>
            The change-note for this deposit isn’t in your local cache yet, so there’s nowhere here to
            receive the credit. <strong>Your funds are safe in the vault</strong> — nothing is lost.
            Restore re-derives your notes from chain (one signature) and recovers the missing note, then
            you can claim again.
          </>
        ) : isStructural ? (
          <>
            This position is missing the on-chain data needed to build a close proof on your device.
            <strong> Your funds are safe in the vault</strong> — nothing is lost. They can still be
            settled when the market resolves, or released through operator recovery.
          </>
        ) : (
          <>
            This deposit’s notes appear fully spent locally, so there’s no note to receive the credit.
            <strong> Your funds are safe in the vault</strong> — nothing is lost. Reach out and the
            operator can release this credit for you.
          </>
        )}
      </p>

      {!isNoFreeNote && (
        <p className="small" style={{ margin: 0, color: 'var(--text-3)' }}>
          In beta the signing operator is a centralized service. If a credit can’t land on your device,
          an admin escape hatch / operator recovery can release the funds after a timelock.
        </p>
      )}

      {detail && (
        <p className="mono" style={{ margin: 0, fontSize: 11, color: 'var(--text-3)', wordBreak: 'break-word' }}>
          {detail}
        </p>
      )}

      <div className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
        <button className="btn btn-ghost" onClick={onClose}>Close</button>
        {isNoFreeNote ? (
          <button
            className="btn btn-primary"
            disabled={restoring}
            onClick={() => onRestore?.()}
          >
            {restoring ? 'Restoring…' : 'Restore from chain'}
          </button>
        ) : (
          <a className="btn btn-primary" href={href} target="_blank" rel="noopener noreferrer">
            Contact support
          </a>
        )}
      </div>
    </div>
  )
}
