// Server component. Parses an authored Markdown body to React elements at RENDER
// time (react-markdown — NOT compiled MDX, which crashed under React 18 + Next 15
// RSC). Security model: raw HTML in the body is IGNORED (no rehype-raw, no
// dangerouslySetInnerHTML), so a post can never inject script or relax the CSP —
// content is data, and the only components it can mount are this allowlisted map.
//
// Capabilities: GitHub-flavored Markdown (incl. tables), emoji, LaTeX math in $$…$$
// (rehype-katex), heading anchors on every level (rehype-slug), images with captions,
// safe external links, and the in-house branded blocks via directives (see
// remarkDirectiveBlocks.ts). The interactive diagrams are client islands; everything
// else renders on the server with zero client JS.
import type { ComponentType, ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkDirective from 'remark-directive'
import rehypeSlug from 'rehype-slug'
import rehypeKatex from 'rehype-katex'
import remarkDirectiveBlocks from '@/lib/remarkDirectiveBlocks'
import {
  PrivacyDiagram,
  LifecycleDiagram,
  NoteDiagram,
  MerkleDiagram,
  ZkProofDiagram,
  ArchitectureDiagram,
  PredictionMarketDiagram,
  AccountVsNotesDiagram,
  SpendDiagram,
} from '@/components/docs/DocKit'

/* eslint-disable @typescript-eslint/no-explicit-any */

// Allowlisted diagrams, addressable by `::diagram{name="…"}`. Aliases included so an
// author can write the natural name. Unknown names render nothing (never an error).
const DIAGRAMS: Record<string, ComponentType> = {
  privacy: PrivacyDiagram,
  lifecycle: LifecycleDiagram,
  note: NoteDiagram,
  notes: NoteDiagram,
  merkle: MerkleDiagram,
  zkproof: ZkProofDiagram,
  'zk-proof': ZkProofDiagram,
  architecture: ArchitectureDiagram,
  predictionmarket: PredictionMarketDiagram,
  'prediction-market': PredictionMarketDiagram,
  accountvsnotes: AccountVsNotesDiagram,
  'account-vs-notes': AccountVsNotesDiagram,
  spend: SpendDiagram,
}

function payloadOf(node: any): any {
  try {
    return JSON.parse(node?.properties?.payload ?? '{}')
  } catch {
    return {}
  }
}

function isImageOnly(node: any): boolean {
  const els = (node?.children ?? []).filter(
    (c: any) => !(c.type === 'text' && /^\s*$/.test(c.value)),
  )
  return els.length === 1 && els[0].type === 'element' && els[0].tagName === 'img'
}

// Make every heading a clickable self-anchor (the id comes from rehype-slug). Clicking
// the heading on the page jumps to it and puts the deep link in the URL — same target the
// ToC uses. Styled to look like a normal heading, with a faint # affordance on hover.
const heading = (Tag: any) =>
  function Heading({ node, children }: any) {
    const id = node?.properties?.id
    if (!id) return <Tag>{children}</Tag>
    return (
      <Tag id={id}>
        <a href={`#${id}`} className="heading-anchor">
          {children}
        </a>
      </Tag>
    )
  }

const components = {
  // Unwrap a paragraph that is just an image so the <figure> isn't nested in a <p>
  // (invalid HTML / hydration error).
  p({ node, children }: any) {
    if (isImageOnly(node)) return <>{children}</>
    return <p>{children}</p>
  },

  // Body image → captioned figure. Caption comes from the Markdown title:
  //   ![alt text](/path.png "Caption shown under the image")
  img({ src, alt, title }: any) {
    if (!src) return null
    return (
      <figure className="bodyfig">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt || ''} loading="lazy" decoding="async" />
        {title && <figcaption className="caption">{title}</figcaption>}
      </figure>
    )
  },

  // Clickable self-anchored headings (every level).
  h2: heading('h2'),
  h3: heading('h3'),
  h4: heading('h4'),

  // External links open safely; internal links are untouched.
  a({ href, children, className }: any) {
    const ext = /^https?:\/\//i.test(href || '')
    return (
      <a
        href={href}
        {...(className ? { className } : {})}
        {...(ext ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      >
        {children}
      </a>
    )
  },

  // Make wide tables scroll on narrow screens.
  table({ children }: any) {
    return (
      <div className="tablewrap">
        <table>{children}</table>
      </div>
    )
  },

  // ── Branded in-house blocks (from directives) ──────────────────────────────
  'ps-answer'({ children }: any): ReactNode {
    return (
      <div className="answer">
        <div className="k">
          <span aria-hidden>⚡</span> Quick answer
        </div>
        {children}
      </div>
    )
  },

  'ps-callout'({ children, variant }: any): ReactNode {
    return <div className={`callout-md callout-${variant || 'note'}`}>{children}</div>
  },

  // The compliance-required "honesty beat": public-on-chain vs private-with-PolyShield.
  'ps-honesty'({ node }: any): ReactNode {
    const { publicItems = [], privateItems = [], note = '' } = payloadOf(node)
    return (
      <div className="pptable">
        <div className="col pub">
          <div className="h">
            <span aria-hidden>◆</span> Public on-chain (by design)
          </div>
          <ul>
            {publicItems.map((it: string, i: number) => (
              <li key={i}>{it}</li>
            ))}
          </ul>
        </div>
        <div className="col priv">
          <div className="h">
            <span aria-hidden>◆</span> Private with PolyShield
          </div>
          <ul>
            {privateItems.map((it: string, i: number) => (
              <li key={i}>{it}</li>
            ))}
            {note && <li className="muted">{note}</li>}
          </ul>
        </div>
      </div>
    )
  },

  // Glossary cross-links.
  'ps-keyterms'({ node }: any): ReactNode {
    const { terms = [] } = payloadOf(node)
    return (
      <div className="terms">
        <div className="k">Key terms</div>
        <dl>
          {terms.map(({ term, href, def }: any, i: number) => (
            <div key={i} style={{ display: 'contents' }}>
              <dt>{href ? <a href={href}>{term}</a> : term}</dt>
              <dd>{def}</dd>
            </div>
          ))}
        </dl>
      </div>
    )
  },

  // Branded explainer diagram (client island).
  'ps-diagram'({ node }: any): ReactNode {
    const { name } = payloadOf(node)
    const Diagram = DIAGRAMS[name]
    return Diagram ? <Diagram /> : null
  },
}

export function MarkdownRenderer({ body }: { body: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm, remarkMath, remarkDirective, remarkDirectiveBlocks]}
      rehypePlugins={[rehypeSlug, [rehypeKatex, { throwOnError: false, strict: false }]]}
      components={components as unknown as Components}
    >
      {body}
    </Markdown>
  )
}
