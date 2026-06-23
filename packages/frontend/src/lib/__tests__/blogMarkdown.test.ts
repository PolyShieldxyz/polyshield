import { describe, it, expect } from 'vitest'
import {
  stripReviewerSections,
  stripHtmlComments,
  stripTrailingDisclaimer,
  stripFaqSection,
  cleanBody,
  extractHeadings,
  extractFaq,
} from '@/lib/blogMarkdown'

describe('stripReviewerSections', () => {
  it('removes everything from the reviewer-notes heading to EOF', () => {
    const md = `# Title\n\nBody text.\n\n## Notes (reviewer)\n\nClaim-source: secret stuff\n- [x] checklist`
    const out = stripReviewerSections(md)
    expect(out).toContain('Body text.')
    expect(out).not.toContain('Notes (reviewer)')
    expect(out).not.toContain('checklist')
    expect(out).not.toContain('secret stuff')
  })
  it('is a no-op when there is no reviewer section', () => {
    const md = `# Title\n\nBody.\n`
    expect(stripReviewerSections(md)).toBe(md)
  })
})

describe('stripHtmlComments', () => {
  it('removes ASSET build-hint comments', () => {
    const md = `Text\n<!-- ASSET: build.mjs announce title="x" -->\nMore`
    const out = stripHtmlComments(md)
    expect(out).not.toContain('ASSET')
    expect(out).toContain('Text')
    expect(out).toContain('More')
  })
})

describe('stripTrailingDisclaimer', () => {
  it('removes a trailing rule + italic legal line', () => {
    const md = `Body.\n\n---\n\n*PolyShield is experimental software on Polygon mainnet beta.*\n`
    const out = stripTrailingDisclaimer(md)
    expect(out).toContain('Body.')
    expect(out).not.toContain('experimental software')
  })
  it('keeps a mid-body horizontal rule', () => {
    const md = `A\n\n---\n\nB\n`
    expect(stripTrailingDisclaimer(md)).toContain('B')
  })
})

describe('cleanBody (full pipeline)', () => {
  it('strips comments, disclaimer, and reviewer notes together', () => {
    const md = `# T\n\nReal body.\n<!-- ASSET: x -->\n\n---\n\n*Disclaimer line here.*\n\n## Notes (reviewer)\n\ninternal`
    const out = cleanBody(md)
    expect(out).toContain('Real body.')
    expect(out).not.toContain('ASSET')
    expect(out).not.toContain('Disclaimer line')
    expect(out).not.toContain('internal')
  })
})

describe('stripFaqSection', () => {
  it('removes the ## FAQ section so it is not double-rendered', () => {
    const md = `## Intro\n\ntext\n\n## FAQ\n\n**Q?**\nA.\n\n## After\n\nmore`
    const out = stripFaqSection(md)
    expect(out).toContain('## Intro')
    expect(out).toContain('## After')
    expect(out).not.toContain('## FAQ')
    expect(out).not.toContain('**Q?**')
  })
  it('removes a trailing FAQ at EOF', () => {
    const md = `## Intro\n\ntext\n\n## FAQ\n\n**Q?**\nA.`
    const out = stripFaqSection(md)
    expect(out).not.toContain('FAQ')
    expect(out).toContain('## Intro')
  })
})

describe('extractHeadings', () => {
  it('returns H2/H3 with slug ids, skipping H1, FAQ and Notes', () => {
    const md = `# Title\n\n## What's visible\n\ntext\n\n### A sub point\n\n## FAQ\n\n## Notes (reviewer)`
    const hs = extractHeadings(md)
    expect(hs).toEqual([
      { depth: 2, text: "What's visible", id: 'whats-visible' },
      { depth: 3, text: 'A sub point', id: 'a-sub-point' },
    ])
  })
  it('disambiguates duplicate headings like rehype-slug', () => {
    const md = `## Same\n\n## Same`
    const hs = extractHeadings(md)
    expect(hs.map((h) => h.id)).toEqual(['same', 'same-1'])
  })
  it('ignores # inside fenced code blocks', () => {
    const md = '## Real\n\n```\n## not a heading\n```\n'
    const hs = extractHeadings(md)
    expect(hs).toEqual([{ depth: 2, text: 'Real', id: 'real' }])
  })
  it('strips inline markdown from heading text before slugging', () => {
    const md = '## The **bold** word'
    const [h] = extractHeadings(md)
    expect(h.text).toBe('The bold word')
    expect(h.id).toBe('the-bold-word')
  })
})

describe('extractFaq', () => {
  it('parses bold-question / paragraph-answer pairs', () => {
    const md = `## FAQ\n\n**Can people see my bets?**\nYes, all of them.\n\n**Is it anonymous?**\nNo, pseudonymous.\n`
    const faq = extractFaq(md)
    expect(faq).toEqual([
      { q: 'Can people see my bets?', a: 'Yes, all of them.' },
      { q: 'Is it anonymous?', a: 'No, pseudonymous.' },
    ])
  })
  it('also supports ### sub-heading questions and multi-line answers', () => {
    const md = `## FAQ\n\n### What is it?\nLine one.\nLine two.\n`
    const faq = extractFaq(md)
    expect(faq).toEqual([{ q: 'What is it?', a: 'Line one. Line two.' }])
  })
  it('stops at the next top-level section', () => {
    const md = `## FAQ\n\n**Q?**\nA.\n\n## Other\n\n**Not a question**\nignored`
    const faq = extractFaq(md)
    expect(faq).toEqual([{ q: 'Q?', a: 'A.' }])
  })
  it('returns [] when there is no FAQ', () => {
    expect(extractFaq('## Intro\n\ntext')).toEqual([])
  })
})
