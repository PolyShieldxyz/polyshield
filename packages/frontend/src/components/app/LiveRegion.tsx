'use client'

/**
 * A11Y (WCAG 2.2 §4.1.3 Status Messages): a visually-hidden ARIA live region for the
 * long-async money flows (proof generation 30s–2min → relay → on-chain confirmation).
 *
 * Without this, a screen-reader user who triggers a bet / deposit / withdraw / settlement
 * hears nothing for up to two minutes and is never told it succeeded or failed. The region
 * is always mounted while the flow is open and its text is swapped as the phase changes, so
 * assistive tech announces each transition without moving focus.
 *
 * Use `assertive` (role="alert") for the error phase so failures interrupt; leave it polite
 * for routine progress/success. `message` should be a short human sentence, NOT a raw status
 * enum (e.g. "Generating proof — this can take up to two minutes." / "Bet placed.").
 */
export function LiveRegion({ message, assertive = false }: { message: string; assertive?: boolean }) {
  return (
    <div
      role={assertive ? 'alert' : 'status'}
      aria-live={assertive ? 'assertive' : 'polite'}
      aria-atomic="true"
      className="sr-only"
    >
      {message}
    </div>
  )
}
