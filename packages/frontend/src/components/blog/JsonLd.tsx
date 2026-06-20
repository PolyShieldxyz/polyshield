/* JSON-LD emitters (server). Built from the same `meta` the page renders, so the
   structured data and the visible content can never diverge. */
import type { PostMeta } from '@/lib/blog'
import { SITE_URL } from '@/lib/brand'

function abs(p: string): string {
  return p.startsWith('http') ? p : `${SITE_URL}${p}`
}

function Script({ data }: { data: object }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }} />
}

export function BlogPostJsonLd({ meta }: { meta: PostMeta }) {
  const url = `${SITE_URL}/blog/${meta.slug}`
  const schemas: string[] = meta.schema ?? ['Article', 'FAQPage']

  const graph: object[] = [
    {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL },
        { '@type': 'ListItem', position: 2, name: 'Blog', item: `${SITE_URL}/blog` },
        { '@type': 'ListItem', position: 3, name: meta.title, item: url },
      ],
    },
    {
      '@type': 'Article',
      '@id': `${url}#article`,
      headline: meta.title,
      description: meta.description,
      image: abs(meta.og_image ?? meta.hero_image.src),
      datePublished: meta.date,
      dateModified: meta.date_modified ?? meta.date,
      author: { '@type': 'Organization', name: meta.author, url: SITE_URL },
      publisher: { '@id': `${SITE_URL}/#organization` },
      mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    },
  ]

  if (schemas.includes('FAQPage') && meta.faq?.length) {
    graph.push({
      '@type': 'FAQPage',
      '@id': `${url}#faq`,
      mainEntity: meta.faq.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    })
  }

  return <Script data={{ '@context': 'https://schema.org', '@graph': graph }} />
}

export function BlogIndexJsonLd() {
  return (
    <Script
      data={{
        '@context': 'https://schema.org',
        '@type': 'Blog',
        '@id': `${SITE_URL}/blog#blog`,
        name: 'PolyShield Blog',
        description: 'Privacy on Polymarket, explained — what leaks, why it matters, and how zero-knowledge cryptography fixes it.',
        url: `${SITE_URL}/blog`,
        publisher: { '@id': `${SITE_URL}/#organization` },
      }}
    />
  )
}
