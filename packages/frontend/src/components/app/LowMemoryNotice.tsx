'use client'

import { deviceMemoryGB, LOW_MEMORY_GB } from '@/lib/prover'

/**
 * PERF-002: pre-flight low-RAM warning shown before a proof-generating action.
 *
 * In-browser Groth16 proving transiently allocates 1–4 GB+ (the zkey plus the depth-32 witness),
 * which can OOM/crash a tab on a memory-constrained device — surfacing to the user as an opaque
 * "the tab died" mid-proof, on the very screen that custodies their money. `navigator.deviceMemory`
 * is a coarse, privacy-bucketed hint; when it reports below LOW_MEMORY_GB we warn UP FRONT (before
 * the user invests time/attention in a proof) rather than only after a crash or timeout.
 *
 * Renders nothing when memory is adequate or the hint is unavailable (Firefox/Safari don't expose
 * it) — i.e. it never nags a capable device and never guesses when it can't measure.
 */
export function LowMemoryNotice() {
  const gb = deviceMemoryGB()
  if (gb == null || gb >= LOW_MEMORY_GB) return null
  return (
    <div
      role="note"
      className="panel"
      style={{ padding: 12, borderColor: 'var(--amber)', display: 'flex', gap: 10, alignItems: 'flex-start' }}
    >
      <span aria-hidden style={{ color: 'var(--amber)', fontSize: 14, lineHeight: 1.4 }}>⚠</span>
      <div className="small" style={{ fontSize: 12 }}>
        This device reports only ~{gb} GB of RAM. Generating the zero-knowledge proof can use several
        GB of memory and may crash this browser tab. For the smoothest experience, close other tabs
        first — or use a desktop with more RAM.
      </div>
    </div>
  )
}
