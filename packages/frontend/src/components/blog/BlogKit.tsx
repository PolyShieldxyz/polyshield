'use client'
/* BlogKit — authoring components for TSX blog posts. Client module (the diagrams it
   re-exports from DocKit are 'use client'); the post body is SSR'd into the HTML for
   SEO, then hydrated. Native-element wrappers (P/H2/Bullets) emit plain tags so the
   `.blog .mdx …` rules in blog.css style them; H2 auto-slugs its id for the TOC. */
import type { ReactNode } from 'react'
import { slugifyHeading } from '@/lib/blogFormat'

/* Re-export the shared prose primitives + concept diagrams so a post imports
   everything from one place. */
export {
  Lead,
  Code,
  Pre,
  Callout,
  Term,
  LifecycleDiagram,
  PrivacyDiagram,
  NoteDiagram,
  MerkleDiagram,
  ZkProofDiagram,
  ArchitectureDiagram,
  SpendDiagram,
  PredictionMarketDiagram,
  AccountVsNotesDiagram,
} from '@/components/docs/DocKit'

export function P({ children }: { children: ReactNode }) {
  return <p>{children}</p>
}

function nodeText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const props = (node as any)?.props
  return props?.children ? nodeText(props.children) : ''
}

/** H2 with an auto-derived slug id (matches PostMeta.toc → TOC anchors). */
export function H2({ children }: { children: ReactNode }) {
  return <h2 id={slugifyHeading(nodeText(children))}>{children}</h2>
}

export function H3({ children }: { children: ReactNode }) {
  return <h3>{children}</h3>
}

export function Bullets({ children }: { children: ReactNode }) {
  return <ul>{children}</ul>
}

/* AEO answer block — the ≤50-word direct answer that wins snippets / LLM citations.
   A styled paragraph, NOT a heading, so the h1→h2 outline stays intact. */
export function Answer({ children }: { children: ReactNode }) {
  return (
    <div className="answer">
      <div className="k">
        <span aria-hidden>⚡</span> Quick answer
      </div>
      <p>{children}</p>
    </div>
  )
}

/* The "honesty beat": what's public by design vs what the cryptography hides. */
export function PublicPrivate({
  publicItems,
  privateItems,
  note,
}: {
  publicItems: ReactNode[]
  privateItems: ReactNode[]
  note?: ReactNode
}) {
  return (
    <div className="pptable">
      <div className="col pub">
        <div className="h">
          <span aria-hidden>◆</span> Public on-chain (by design)
        </div>
        <ul>
          {publicItems.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      </div>
      <div className="col priv">
        <div className="h">
          <span aria-hidden>◆</span> Private with PolyShield
        </div>
        <ul>
          {privateItems.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
          {note && <li className="muted">{note}</li>}
        </ul>
      </div>
    </div>
  )
}

/* Glossary cross-links — required on ZK/explainer posts (cluster links down to /docs). */
export function KeyTerms({ terms }: { terms: [term: string, href: string, def: ReactNode][] }) {
  return (
    <div className="terms">
      <div className="k">Key terms</div>
      <dl>
        {terms.map(([term, href, def], i) => (
          <div key={i} style={{ display: 'contents' }}>
            <dt>
              <a href={href}>{term}</a>
            </dt>
            <dd>{def}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/* Numbered steps (HowTo-shaped). */
export function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol className="steps">
      {items.map((it, i) => (
        <li key={i}>
          <span>{it}</span>
        </li>
      ))}
    </ol>
  )
}
