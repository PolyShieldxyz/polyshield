// Pure Markdown text helpers — NO fs, NO React, NO unified/remark. Safe to import
// from anywhere and unit-testable in the node vitest environment. These run over the
// raw Markdown body BEFORE it is handed to the react-markdown renderer.
import GithubSlugger from 'github-slugger'
import type { FaqItem } from './blog'

/** Strip the internal "Notes (reviewer)" / compliance-checklist tail so it never
 *  ships. Everything from the first `## Notes (reviewer)` (any heading level,
 *  case-insensitive) to EOF is removed. */
export function stripReviewerSections(md: string): string {
  const m = md.match(/^\s{0,3}#{1,6}\s+Notes\s*\(reviewer\)/im)
  return m && m.index != null ? md.slice(0, m.index).trimEnd() + '\n' : md
}

/** Remove HTML comments (e.g. the `<!-- ASSET: ... -->` build hints authors leave
 *  for the image generator). Raw HTML is already ignored by the renderer; this just
 *  keeps the source clean and avoids stray whitespace nodes. */
export function stripHtmlComments(md: string): string {
  return md.replace(/<!--[\s\S]*?-->/g, '')
}

/** Drop a trailing thematic-break + italic legal disclaimer block, if present. The
 *  post route renders its own standardized risk line, so an inline duplicate is
 *  redundant. Only strips a final `---` followed by an emphasized-only paragraph. */
export function stripTrailingDisclaimer(md: string): string {
  return md.replace(/\n-{3,}\s*\n+\s*\*[^*][\s\S]*?\*\s*$/i, '\n').trimEnd() + '\n'
}

/** Full pre-render cleanup pipeline for an authored body. */
export function cleanBody(md: string): string {
  return stripTrailingDisclaimer(stripHtmlComments(stripReviewerSections(md)))
}

/** Remove the `## FAQ` section from the body. The FAQ is rendered by the post route
 *  as a styled block (from the extracted/structured Q&A), so leaving it in the body
 *  would double it. Removes from the FAQ heading to the next H1/H2 or EOF. */
export function stripFaqSection(md: string): string {
  const lines = md.split('\n')
  const start = lines.findIndex((l) => /^\s{0,3}#{1,2}\s+FAQ\s*$/i.test(l))
  if (start < 0) return md
  let end = lines.length
  for (let j = start + 1; j < lines.length; j++) {
    if (/^\s{0,3}#{1,2}\s+\S/.test(lines[j])) {
      end = j
      break
    }
  }
  return (lines.slice(0, start).join('\n').trimEnd() + '\n' + lines.slice(end).join('\n')).trimEnd() + '\n'
}

/** Remove inline Markdown markers from heading text so the visible TOC label and the
 *  slugger input match what rehype-slug sees (it slugs rendered text content). */
function cleanInline(text: string): string {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim()
}

export interface ExtractedHeading {
  depth: number
  text: string
  id: string
}

/** Parse ATX headings (## and ###) into {depth,text,id}. The id is produced with the
 *  SAME github-slugger rehype-slug uses (fresh instance, document order), so the TOC
 *  anchors line up with the rendered heading ids — including duplicate-suffix (-1)
 *  behavior. The H1 (post title) and the FAQ/Notes headings are skipped. Code fences
 *  are ignored so `#` inside a code block is never mistaken for a heading. */
export function extractHeadings(md: string, maxDepth = 3): ExtractedHeading[] {
  const slugger = new GithubSlugger()
  const out: ExtractedHeading[] = []
  let inFence = false
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (!m) continue
    const depth = m[1].length
    if (depth < 2 || depth > maxDepth) continue
    const text = cleanInline(m[2])
    if (/^(faq|notes\b)/i.test(text)) continue
    out.push({ depth, text, id: slugger.slug(text) })
  }
  return out
}

/** Extract a `## FAQ` section into structured Q/A pairs, regardless of exact author
 *  formatting: a question is a bold line (`**...?**`) or a `### ...` sub-heading; the
 *  answer is the prose until the next question/heading. This guarantees FAQPage
 *  structured data even when the writer types the FAQ as plain prose. */
export function extractFaq(md: string): FaqItem[] {
  const lines = md.split('\n')
  let i = lines.findIndex((l) => /^\s{0,3}#{1,6}\s+FAQ\s*$/i.test(l))
  if (i < 0) return []
  i += 1
  const faq: FaqItem[] = []
  let q: string | null = null
  let buf: string[] = []
  const flush = () => {
    if (q) {
      const a = buf.join(' ').replace(/\s+/g, ' ').trim()
      if (a) faq.push({ q, a })
    }
    q = null
    buf = []
  }
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s{0,3}#{1,2}\s+\S/.test(line)) break // next top-level section ends the FAQ
    const bold = line.match(/^\s*\*\*(.+?)\*\*\s*$/)
    const h3 = line.match(/^\s{0,3}#{3,6}\s+(.+?)\s*$/)
    const qLine = bold?.[1] ?? h3?.[1]
    if (qLine) {
      flush()
      q = cleanInline(qLine).trim()
      continue
    }
    if (q) buf.push(line)
  }
  flush()
  return faq
}
