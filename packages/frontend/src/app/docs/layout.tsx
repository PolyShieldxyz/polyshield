import type { Metadata } from 'next'

// SEO: default metadata for the /docs segment. Each /docs/[slug] page overrides
// title/description/canonical via generateMetadata; the bare /docs index redirects
// to the first page, so this mainly serves as the section-level fallback.
export const metadata: Metadata = {
  title: 'Docs — PolyShield ZK privacy vault for Polymarket',
  description:
    'How PolyShield works: the privacy model, zero-knowledge proofs, notes, the Merkle tree & nullifiers, architecture, security, and a glossary of terms.',
}

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return children
}
