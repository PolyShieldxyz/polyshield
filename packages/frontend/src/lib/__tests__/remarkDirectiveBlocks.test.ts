import { describe, it, expect } from 'vitest'
import remarkDirectiveBlocks from '@/lib/remarkDirectiveBlocks'

/* eslint-disable @typescript-eslint/no-explicit-any */
// Build mdast nodes by hand so the transform is tested without a full markdown parser
// (and without depending on non-direct deps like unified/remark-parse).
const text = (v: string) => ({ type: 'text', value: v })
const para = (...kids: any[]) => ({ type: 'paragraph', children: kids })
const li = (...kids: any[]) => ({ type: 'listItem', children: kids })
const list = (...items: any[]) => ({ type: 'list', children: items })
const lnk = (url: string, label: string) => ({ type: 'link', url, children: [text(label)] })
const root = (...kids: any[]) => ({ type: 'root', children: kids })

const run = (tree: any) => {
  remarkDirectiveBlocks()(tree)
  return tree
}

describe('remarkDirectiveBlocks', () => {
  it('honesty → ps-honesty with public/private items + note, children cleared', () => {
    const node: any = {
      type: 'containerDirective',
      name: 'honesty',
      attributes: { note: 'Deposits stay public.' },
      children: [
        list(li(para(text('a'))), li(para(text('b')))),
        list(li(para(text('c')))),
      ],
    }
    run(root(node))
    expect(node.data.hName).toBe('ps-honesty')
    const payload = JSON.parse(node.data.hProperties.payload)
    expect(payload.publicItems).toEqual(['a', 'b'])
    expect(payload.privateItems).toEqual(['c'])
    expect(payload.note).toBe('Deposits stay public.')
    expect(node.children).toEqual([])
  })

  it('keyterms → ps-keyterms with {term, href, def} parsed from each item', () => {
    const node: any = {
      type: 'containerDirective',
      name: 'keyterms',
      attributes: {},
      children: [list(li(para(lnk('/docs', 'Anonymity set'), text(': Indistinguishable depositors.'))))],
    }
    run(root(node))
    expect(node.data.hName).toBe('ps-keyterms')
    const payload = JSON.parse(node.data.hProperties.payload)
    expect(payload.terms[0]).toEqual({
      term: 'Anonymity set',
      href: '/docs',
      def: 'Indistinguishable depositors.',
    })
  })

  it('diagram → ps-diagram with lowercased name', () => {
    const node: any = { type: 'leafDirective', name: 'diagram', attributes: { name: 'Privacy' }, children: [] }
    run(root(node))
    expect(node.data.hName).toBe('ps-diagram')
    expect(JSON.parse(node.data.hProperties.payload)).toEqual({ name: 'privacy' })
  })

  it('answer → ps-answer and KEEPS its children', () => {
    const node: any = { type: 'containerDirective', name: 'answer', attributes: {}, children: [para(text('Yes.'))] }
    run(root(node))
    expect(node.data.hName).toBe('ps-answer')
    expect(node.children).toHaveLength(1)
  })

  it('unknown directive collapses to an inert div (never a live tag)', () => {
    const node: any = { type: 'containerDirective', name: 'whatever', attributes: {}, children: [para(text('x'))] }
    run(root(node))
    expect(node.data.hName).toBe('div')
  })
})
