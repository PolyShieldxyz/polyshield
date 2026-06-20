'use client'
import { KV } from '@/components/app/KV'

// Deterministic pseudo-random in [0,1) from an integer key. Replaces Math.random() in the
// decorative SVGs below: Math.random() yields different values on the server vs the client,
// so the SSR-rendered attributes mismatched on hydration (React hydration error). A pure
// function of the index renders identically on both passes.
function seededRand(key: number): number {
  let t = (key + 0x6d2b79f5) >>> 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

function AnonSetGraph() {
  const bars = [42, 61, 78, 95, 120, 148, 180, 210, 240, 260, 280, 295, 310, 318, 325, 330, 335, 338, 340, 342]
  const max = Math.max(...bars)
  return (
    <svg viewBox="0 0 320 100" width="100%">
      {bars.map((v, i) => {
        const h = (v / max) * 80
        const x = 8 + i * 15.5
        const isLast = i === bars.length - 1
        return (
          <g key={i}>
            <rect x={x} y={100 - h - 10} width={12} height={h}
              fill={isLast ? 'var(--cyan)' : 'rgba(255,255,255,0.12)'} rx={2} />
            {isLast && <text x={x + 6} y={100 - h - 14} textAnchor="middle" fontFamily="JetBrains Mono" fontSize="8" fill="var(--cyan)">{v}</text>}
          </g>
        )
      })}
      <text x="0" y="98" fontFamily="JetBrains Mono" fontSize="8" fill="rgba(255,255,255,0.3)">20 days ago</text>
      <text x="260" y="98" fontFamily="JetBrains Mono" fontSize="8" fill="rgba(255,255,255,0.3)">today</text>
    </svg>
  )
}

function ActivityHeatmap() {
  const hours = Array.from({ length: 24 }, (_, h) => h)
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const data = days.map((_, di) => hours.map((_h, hi) => seededRand(di * 24 + hi)))
  return (
    <svg viewBox="0 0 340 80" width="100%">
      {days.map((day, di) =>
        hours.map((_, hi) => {
          const v = data[di][hi]
          const x = 30 + hi * 13
          const y = di * 10 + 2
          return (
            <rect key={`${di}-${hi}`} x={x} y={y} width={11} height={8} rx={1}
              fill={`oklch(0.82 0.13 85 / ${v * 0.6 + 0.05})`} />
          )
        })
      )}
      {days.map((day, di) => (
        <text key={day} x="0" y={di * 10 + 9} fontFamily="JetBrains Mono" fontSize="7" fill="rgba(255,255,255,0.4)">{day}</text>
      ))}
      {[0, 6, 12, 18, 23].map((h) => (
        <text key={h} x={30 + h * 13} y={76} fontFamily="JetBrains Mono" fontSize="7" fill="rgba(255,255,255,0.3)">{h}h</text>
      ))}
    </svg>
  )
}

function ClusteringGraph() {
  const nodes = Array.from({ length: 28 }, (_, i) => ({
    x: 30 + seededRand(i * 3) * 220,
    y: 20 + seededRand(i * 3 + 1) * 100,
    r: 3 + seededRand(i * 3 + 2) * 5,
    you: i === 14,
  }))
  return (
    <svg viewBox="0 0 280 140" width="100%">
      {nodes.map((n, i) => (
        <g key={i}>
          {n.you && <circle cx={n.x} cy={n.y} r={n.r + 6} fill="oklch(0.82 0.13 85 / 0.1)" />}
          <circle cx={n.x} cy={n.y} r={n.r}
            fill={n.you ? 'var(--cyan)' : 'rgba(255,255,255,0.2)'}
            stroke={n.you ? 'var(--cyan)' : 'none'} />
          {n.you && <text x={n.x + n.r + 4} y={n.y + 4} fontFamily="JetBrains Mono" fontSize="8" fill="var(--cyan)">YOU</text>}
        </g>
      ))}
      <text x="0" y="135" fontFamily="JetBrains Mono" fontSize="8" fill="rgba(255,255,255,0.3)">cluster analysis — no linkage detected</text>
    </svg>
  )
}

export default function PrivacyPage() {
  // ILLUSTRATIVE PREVIEW. These figures are sample values, not live measurements of the
  // connected account — the metrics pipeline (anonymity set, k-anonymity, timing entropy,
  // decoy density) is not computed yet. The page is shipped as a labeled preview of the
  // privacy dashboard, NOT as a measurement. Do not present these as real numbers: showing
  // specific-looking values as if measured would be a trust violation for a privacy product.
  // See docs/ui-ux-audit-2026-06-15.md (PRIV-001).
  const metrics = [
    { label: 'Anonymity score', value: '94/100', color: 'var(--cyan)', note: 'Composite of set size, timing entropy, decoy density' },
    { label: 'Anonymity set', value: '1,842', color: 'var(--cyan)', note: 'Unique wallets in the current pool window' },
    { label: 'Timing entropy', value: '7.4 bits', color: 'var(--green)', note: 'Bits of uncertainty in withdrawal timing' },
    { label: 'K-anonymity', value: 'k = 312', color: 'var(--green)', note: 'Min wallets with indistinguishable deposit patterns' },
    { label: 'Unlinkability', value: '99.8%', color: 'var(--violet)', note: 'Prob. no observer links withdrawal to deposit' },
    { label: 'Decoy density', value: '12.3%', color: 'var(--text-2)', note: 'Fraction of traffic that is decoy (future feature)' },
  ]

  return (
    <div>
      <div className="row hairline-b" style={{ padding: '14px 24px', justifyContent: 'space-between' }}>
        <div className="row gap-4">
          <div className="micro">PRIVACY METRICS</div>
        </div>
        <span className="pill pill-amber" style={{ fontSize: 10 }}>PREVIEW · SAMPLE DATA</span>
      </div>

      <div style={{ padding: 24 }}>
        {/* PRIV-001: honest framing — the whole dashboard is illustrative until the metrics
            pipeline lands. The banner makes that unmistakable before any number is read. */}
        <div className="callout" style={{ borderColor: 'oklch(0.82 0.14 55 / 0.35)', padding: '12px 16px', marginBottom: 20, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--amber)', flexShrink: 0, marginTop: 5 }} />
          <div className="small" style={{ fontSize: 12, color: 'var(--text-1)' }}>
            <strong style={{ color: 'var(--text)' }}>Illustrative preview.</strong> The figures below are sample values that
            show how this dashboard will look — they are <em>not</em> live measurements of your account. Live privacy metrics
            arrive in a later release.
          </div>
        </div>

        {/* Metric tiles */}
        <div className="m-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 24 }}>
          {metrics.map(({ label, value, color, note }) => (
            <div key={label} className="panel" style={{ padding: '14px 16px', position: 'relative' }}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                <div className="micro" style={{ fontSize: 9 }}>{label.toUpperCase()}</div>
                <span className="micro" style={{ fontSize: 8, color: 'var(--text-3)', letterSpacing: '0.1em' }}>SAMPLE</span>
              </div>
              <div className="num mt-1" style={{ fontSize: 22, color }}>{value}</div>
              <div className="small mt-1" style={{ fontSize: 10 }}>{note}</div>
            </div>
          ))}
        </div>

        <div className="m-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
          <div>
            <div className="panel" style={{ padding: 20 }}>
              <div className="micro">ANONYMITY SET GROWTH</div>
              <div className="mt-3">
                <AnonSetGraph />
              </div>
              <div className="hairline-t mt-3" style={{ paddingTop: 12 }}>
                <KV l="Current size" v="1,842 wallets" />
                <KV l="30-day growth" v="+312 wallets" />
                <KV l="Pool inception" v="Mar 1, 2026" />
              </div>
            </div>

            <div className="panel mt-4" style={{ padding: 20 }}>
              <div className="micro">CLUSTER ANALYSIS</div>
              <div className="mt-3">
                <ClusteringGraph />
              </div>
              <div className="small mt-2" style={{ fontSize: 11 }}>
                Illustrative: in a mature pool, deposit-to-withdrawal linkage analysis would show your activity pattern
                blended among the other wallets in the anonymity set, with no detectable cluster.
              </div>
            </div>
          </div>

          <div>
            <div className="panel" style={{ padding: 20 }}>
              <div className="micro">ACTIVITY HEATMAP (UTC)</div>
              <div className="mt-3">
                <ActivityHeatmap />
              </div>
              <div className="small mt-3" style={{ fontSize: 11 }}>
                Transaction timing randomized by relay jitter. No time-of-day fingerprint detectable.
              </div>
            </div>

            <div className="panel mt-4" style={{ padding: 20 }}>
              <div className="micro">PRIVACY BREAKDOWN</div>
              <div className="col mt-3 gap-3">
                {[
                  ['Merkle anonymity', 'Your commitment is one leaf among many in the append-only Merkle tree. A root-membership proof shows inclusion without revealing which leaf is yours.', 'var(--cyan)'],
                  ['Nullifier unlinkability', 'Nullifiers are poseidon(secret, nonce). No observer can link a nullifier to a deposit address.', 'var(--green)'],
                  ['Relay separation', 'Proof relay submits transactions. Your wallet never appears in bet, settle, or withdraw calldata.', 'var(--violet)'],
                  ['Timing entropy', 'Withdraw relay adds random jitter (3–12 min standard, up to 60 min paranoid). Breaks timing correlation.', 'var(--amber)'],
                  ['Anonymous analytics', 'During beta we count which markets/tags/sorts/searches are popular to tune what we fetch. Aggregate counts only — no wallet address, no IP, no per-user id. Browsing is never linked to your wallet or bets.', 'oklch(0.72 0.10 200)'],
                ].map(([label, desc, color]) => (
                  <div key={label as string}>
                    <div className="row gap-2" style={{ alignItems: 'center', marginBottom: 4 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color as string, flexShrink: 0 }} />
                      <span style={{ fontSize: 12, fontWeight: 500 }}>{label as string}</span>
                    </div>
                    <div className="small" style={{ fontSize: 11, paddingLeft: 16 }}>{desc as string}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
