/**
 * PrivacyModel — the single source of truth for what PolyShield does and does NOT hide.
 *
 * The protected property is *which deposit authorized which bet*. The deposit itself is PUBLIC by
 * design, and withdrawals are W→W (back to the depositing wallet), so a deposit↔withdrawal link is
 * trivially observable — PolyShield does not mix funds. Stating this plainly is the most important
 * thing a privacy-vault UI can do: informed consent requires showing the *limits* of the privacy,
 * not just the wins. Rendered at the top of /app/privacy and /app/proofs, and linked from Withdraw.
 *
 * This component contains NO numbers — only honest, always-true statements. Anything quantitative
 * (anonymity-set size, timing) belongs in clearly-labelled SAMPLE tiles, never here.
 */

const PRIVATE: Array<[string, string]> = [
  ['Which deposit authorized which bet', 'The core guarantee. Bets are proven against the shared pool, not your address.'],
  ['The link between you and a fill', 'Every bet exits from the vault’s single shared account — your wallet never signs the order.'],
  ['Your bet amount and side on-chain', 'Submitted by the relay, not from your wallet; your address never appears in bet/settle/withdraw calldata.'],
]

const PUBLIC: Array<[string, string]> = [
  ['That this wallet deposited into the vault', 'The deposit is an ordinary on-chain transfer from your address — visible to anyone.'],
  ['Your deposit amount and time', 'Recorded on-chain. Avoid memorable round numbers if that matters to you.'],
  ['Your withdrawals (W→W)', 'Funds return to the wallet you deposited from, so deposit↔withdrawal is linkable. PolyShield does not mix funds.'],
]

export function PrivacyModel({ style }: { style?: React.CSSProperties }) {
  return (
    <div className="panel" style={{ padding: 20, ...style }}>
      <div className="micro">PRIVACY MODEL — WHAT POLYSHIELD HIDES, AND WHAT IT DOESN’T</div>
      <div className="m-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 14 }}>
        <div>
          <div className="row gap-2" style={{ alignItems: 'center', marginBottom: 8 }}>
            <span aria-hidden="true" style={{ color: 'var(--green)', fontWeight: 600 }}>✓</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--green)', letterSpacing: '0.04em' }}>PRIVATE</span>
          </div>
          <div className="col gap-3">
            {PRIVATE.map(([t, d]) => (
              <div key={t}>
                <div style={{ fontSize: 12.5, fontWeight: 500 }}>{t}</div>
                <div className="small" style={{ fontSize: 11 }}>{d}</div>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="row gap-2" style={{ alignItems: 'center', marginBottom: 8 }}>
            <span aria-hidden="true" style={{ color: 'var(--text-2)', fontWeight: 600 }}>○</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', letterSpacing: '0.04em' }}>PUBLIC — BY DESIGN</span>
          </div>
          <div className="col gap-3">
            {PUBLIC.map(([t, d]) => (
              <div key={t}>
                <div style={{ fontSize: 12.5, fontWeight: 500 }}>{t}</div>
                <div className="small" style={{ fontSize: 11 }}>{d}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="hairline-t small mt-4" style={{ paddingTop: 12, fontSize: 11, color: 'var(--text-2)' }}>
        Beta: a centralized operator signs orders and settlement. If it’s delayed your funds stay safe in the vault. See{' '}
        <a href="/how#faq" style={{ color: 'var(--cyan)' }}>the threat model</a>.
      </div>
    </div>
  )
}

/** One-line inline disclosure for tight spots (e.g. the Withdraw page). */
export function PrivacyModelNote({ style }: { style?: React.CSSProperties }) {
  return (
    <div className="small" style={{ fontSize: 11, color: 'var(--text-2)', ...style }}>
      Your deposit is public on-chain by design. PolyShield hides <strong style={{ color: 'var(--text-1)' }}>which deposit
      authorized which bet</strong> — not that you deposited. Withdrawals return to your own wallet.
    </div>
  )
}
