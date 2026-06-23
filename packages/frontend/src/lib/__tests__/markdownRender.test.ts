import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownRenderer } from '@/components/blog/MarkdownRenderer'

// End-to-end render of the real react-markdown pipeline (GFM + math + directives +
// slug + katex + the component map) to an HTML string. Covers the capabilities the
// migrated posts don't exercise: tables, LaTeX, body images, blockquote callouts.
const render = (body: string) => renderToStaticMarkup(createElement(MarkdownRenderer, { body }))

describe('MarkdownRenderer', () => {
  it('renders GFM tables inside a scroll wrapper', () => {
    const html = render('| A | B |\n|---|---|\n| 1 | 2 |\n')
    expect(html).toContain('class="tablewrap"')
    expect(html).toContain('<table>')
    expect(html).toContain('<th>')
    expect(html).toContain('<td>')
  })

  it('renders LaTeX math via katex', () => {
    const html = render('Inline $a^2+b^2=c^2$ and display:\n\n$$\\frac{1}{2}$$\n')
    expect(html).toContain('katex')
  })

  it('renders a body image as a captioned figure with alt text', () => {
    const html = render('![A wallet diagram](/blog/img/x.png "Figure caption here")')
    expect(html).toContain('class="bodyfig"')
    expect(html).toContain('alt="A wallet diagram"')
    expect(html).toContain('<figcaption')
    expect(html).toContain('Figure caption here')
    // The image must NOT be wrapped in a <p> (invalid nesting).
    expect(html).not.toContain('<p><figure')
  })

  it('renders blockquotes (with emoji) as callouts', () => {
    const html = render('> ⚠️ Never sign from your own wallet.\n')
    expect(html).toContain('<blockquote>')
    expect(html).toContain('⚠️')
  })

  it('adds slug ids to every heading level', () => {
    const html = render('## Top Level\n\n### Sub Heading\n')
    expect(html).toContain('id="top-level"')
    expect(html).toContain('id="sub-heading"')
  })

  it('makes every heading a clickable self-anchor', () => {
    const html = render('## Top Level\n\n### Sub Heading\n')
    // id stays on the heading (scroll/ToC target); the heading text is wrapped in a link.
    expect(html).toContain('<h2 id="top-level"><a href="#top-level"')
    expect(html).toContain('class="heading-anchor"')
    expect(html).toContain('<h3 id="sub-heading"><a href="#sub-heading"')
  })

  it('makes external links safe and leaves internal links bare', () => {
    const html = render('[ext](https://example.com) and [doc](/docs)')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('href="/docs"')
  })

  it('renders the :::honesty directive as the branded PublicPrivate block', () => {
    const body = [
      ':::honesty{note="Deposits are public."}',
      '**Public**',
      '',
      '- The deposit',
      '',
      '**Private**',
      '',
      '- Which bet is yours',
      ':::',
    ].join('\n')
    const html = render(body)
    expect(html).toContain('class="pptable"')
    expect(html).toContain('Public on-chain (by design)')
    expect(html).toContain('Private with PolyShield')
    expect(html).toContain('Which bet is yours')
    expect(html).toContain('Deposits are public.')
  })

  it('does not execute or emit raw HTML embedded in content (XSS guard)', () => {
    const html = render('Hello <script>alert(1)</script> world')
    expect(html).not.toContain('<script>alert(1)</script>')
  })
})
