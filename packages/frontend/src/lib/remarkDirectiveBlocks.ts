// remark plugin: turn the small, ALLOWLISTED set of authoring directives into custom
// hast elements the MarkdownRenderer maps to branded in-house components. Runs AFTER
// remark-directive (which parses the `:::` syntax). Content stays pure data — a
// directive only ever names a known block; unknown names are passed through inert.
//
//   :::honesty{note="…"}            → <ps-honesty payload=…>   (PublicPrivate)
//   **Public …**  - a  - b
//   **Private …** - c
//   :::
//   :::keyterms ::: (a list of `[Term](/href): definition`) → <ps-keyterms payload=…> (KeyTerms)
//   :::answer … :::                 → <ps-answer> (AEO "Quick answer", keeps children)
//   :::callout{type="warn"} … :::   → <ps-callout> (keeps children)
//   ::diagram{name="privacy"}       → <ps-diagram payload=…> (DocKit diagram by name)
import { visit } from 'unist-util-visit'
import { toString as mdToString } from 'mdast-util-to-string'

/* eslint-disable @typescript-eslint/no-explicit-any */

function setHast(node: any, tag: string, props: Record<string, unknown> = {}, keepChildren = true) {
  node.data = node.data || {}
  node.data.hName = tag
  node.data.hProperties = { ...(node.data.hProperties || {}), ...props }
  if (!keepChildren) node.children = []
}

function listsIn(node: any): any[] {
  return (node.children || []).filter((c: any) => c.type === 'list')
}

function itemsOf(list: any): string[] {
  return (list?.children || [])
    .filter((li: any) => li.type === 'listItem')
    .map((li: any) => mdToString(li).trim())
    .filter(Boolean)
}

function parseKeyTerms(list: any): { term: string; href?: string; def: string }[] {
  const out: { term: string; href?: string; def: string }[] = []
  for (const li of list?.children || []) {
    if (li.type !== 'listItem') continue
    const full = mdToString(li).trim()
    let term = ''
    let href: string | undefined
    visit(li, 'link', (lnk: any) => {
      if (!term) {
        term = mdToString(lnk).trim()
        href = lnk.url
      }
    })
    if (!term) {
      const idx = full.indexOf(':')
      term = (idx >= 0 ? full.slice(0, idx) : full).trim()
    }
    const after = full.slice(full.indexOf(term) + term.length)
    const def = after.replace(/^[\s:–—-]+/, '').trim()
    if (term) out.push({ term, href, def })
  }
  return out
}

export default function remarkDirectiveBlocks() {
  return (tree: any) => {
    visit(tree, (node: any) => {
      if (
        node.type !== 'containerDirective' &&
        node.type !== 'leafDirective' &&
        node.type !== 'textDirective'
      ) {
        return
      }
      const name: string = node.name
      const attrs: Record<string, string> = node.attributes || {}

      switch (name) {
        case 'honesty': {
          const lists = listsIn(node)
          const payload = JSON.stringify({
            publicItems: itemsOf(lists[0]),
            privateItems: itemsOf(lists[1]),
            note: attrs.note || '',
          })
          setHast(node, 'ps-honesty', { payload }, false)
          break
        }
        case 'keyterms':
        case 'keyTerms': {
          const payload = JSON.stringify({ terms: parseKeyTerms(listsIn(node)[0]) })
          setHast(node, 'ps-keyterms', { payload }, false)
          break
        }
        case 'answer':
          setHast(node, 'ps-answer', {})
          break
        case 'callout':
          setHast(node, 'ps-callout', { variant: attrs.type || attrs.variant || 'note' })
          break
        case 'diagram': {
          const payload = JSON.stringify({ name: (attrs.name || '').toLowerCase() })
          setHast(node, 'ps-diagram', { payload }, false)
          break
        }
        default:
          // Unknown directive: render its inner content as a plain block, never as a
          // live tag. Leaf/text directives with no children collapse to nothing.
          setHast(node, node.type === 'containerDirective' ? 'div' : 'span', {})
      }
    })
  }
}
