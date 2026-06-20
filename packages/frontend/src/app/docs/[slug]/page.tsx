import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { DOC_PAGES, DOC_SECTIONS, getDocPage } from '@/content/docs'
import { DocsShell } from '../DocsShell'

type Params = { params: Promise<{ slug: string }> }

// Pre-render every doc page at build time so each is a real, crawlable HTML document.
export function generateStaticParams() {
  return DOC_PAGES.map((p) => ({ slug: p.slug }))
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params
  const page = getDocPage(slug)
  if (!page) return {}
  return {
    title: `${page.title} — PolyShield Docs`,
    description: `PolyShield documentation: ${page.section} — ${page.title}.`,
    alternates: { canonical: `/docs/${slug}` },
  }
}

export default async function DocPage({ params }: Params) {
  const { slug } = await params
  const page = getDocPage(slug)
  if (!page) notFound()
  return (
    <DocsShell sections={DOC_SECTIONS} slug={page.slug} section={page.section} title={page.title}>
      {page.body}
    </DocsShell>
  )
}
