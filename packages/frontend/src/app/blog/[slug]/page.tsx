import type { Metadata } from 'next'
import Link from 'next/link'
import Image from 'next/image'
import { notFound } from 'next/navigation'
import { PILLARS, fmtDate, slugifyHeading } from '@/lib/blog'
import { PUBLISHED_POSTS, getPost } from '@/content/blog/registry'
import { Toc, TocMobile } from '@/components/blog/Toc'
import { BlogPostJsonLd } from '@/components/blog/JsonLd'

type Params = { params: Promise<{ slug: string }> }

export function generateStaticParams() {
  return PUBLISHED_POSTS.map((p) => ({ slug: p.meta.slug }))
}

// Drafts are not prebuilt; a direct hit on an unpublished/unknown slug must 404,
// not server-render on demand.
export const dynamicParams = false

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params
  const post = getPost(slug)
  if (!post) return {}
  const { meta } = post
  const ogImage = meta.og_image ?? meta.hero_image.src
  return {
    title: meta.title,
    description: meta.description,
    alternates: { canonical: `/blog/${slug}` },
    openGraph: {
      type: 'article',
      url: `/blog/${slug}`,
      title: meta.title,
      description: meta.description,
      images: [ogImage],
      publishedTime: meta.date,
      modifiedTime: meta.date_modified ?? meta.date,
    },
    twitter: {
      card: 'summary_large_image',
      title: meta.title,
      description: meta.description,
      images: [ogImage],
    },
  }
}

export default async function PostPage({ params }: Params) {
  const { slug } = await params
  const post = getPost(slug)
  if (!post) notFound()
  const { meta, Content } = post

  const headings = [
    ...(meta.toc ?? []).map((t) => ({ id: slugifyHeading(t), text: t })),
    ...(meta.faq?.length ? [{ id: 'faq', text: 'FAQ' }] : []),
  ]
  const { label } = PILLARS[meta.pillar]
  const related = (meta.related ?? [])
    .map(getPost)
    .filter((p): p is NonNullable<typeof p> => p != null)

  return (
    <article>
      <BlogPostJsonLd meta={meta} />

      {/* header */}
      <header className="posthead">
        <div className="b-line-grid" />
        <div className="posthead-inner">
          <nav className="crumb" aria-label="Breadcrumb">
            <Link href="/">Home</Link><span className="sep">›</span>
            <Link href="/blog">Blog</Link><span className="sep">›</span>
            {meta.title}
          </nav>
          <div className="p-eyebrow">{label} · {meta.level}</div>
          <h1>{meta.title}</h1>
          <p className="deck">{meta.subtitle}</p>
          <div className="byline">
            <span className="level">{meta.level}</span><span className="sep">·</span>
            <span>{meta.author}</span><span className="sep">·</span>
            <span>{fmtDate(meta.date)}</span>
            {meta.date_modified && (<><span className="sep">·</span><span className="upd">Updated {fmtDate(meta.date_modified)}</span></>)}
            <span className="sep">·</span><span>⏱ {meta.reading_time} read</span>
          </div>
        </div>
      </header>

      {/* hero image (LCP) */}
      <figure className="herofig">
        <div className="heroimg">
          <Image
            src={meta.hero_image.src}
            alt={meta.hero_image.alt}
            fill
            priority
            sizes="(max-width: 1000px) 100vw, 1000px"
            style={{ objectFit: 'cover' }}
          />
        </div>
        {meta.hero_image.caption && <figcaption className="caption">{meta.hero_image.caption}</figcaption>}
      </figure>

      {/* body + TOC */}
      <div className="wrap">
        <div className="prose">
          <TocMobile headings={headings} />
          <div className="mdx">
            <Content />
          </div>

          {/* CTA band */}
          <div className="ctaband">
            <div>
              <h3>Trade privately on Polymarket</h3>
              <p>Non-custodial, on Polygon. Your wallet never appears on a trade.</p>
            </div>
            <div className="acts">
              <a className="btn btn-brand" href="/app/markets">Launch App →</a>
              <Link className="btn btn-ghost" href="/how">See how it works</Link>
            </div>
          </div>

          {/* risk line */}
          <div className="risk">
            <span className="ic" aria-hidden>⚠</span>
            <span>
              PolyShield is beta software handling real funds. It is not affiliated with Polymarket, and
              nothing here is investment advice. PolyShield hides which depositor authorized which bet — it
              does not hide that a wallet deposited into the vault.
            </span>
          </div>

          {/* FAQ */}
          {meta.faq && meta.faq.length > 0 && (
            <div className="faq">
              <h2 id="faq" style={{ fontSize: 26, borderLeft: '3px solid var(--brand)', paddingLeft: 14, margin: '48px 0 8px' }}>FAQ</h2>
              {meta.faq.map((f, i) => (
                <div key={i}>
                  <h3>{f.q}</h3>
                  <p>{f.a}</p>
                </div>
              ))}
            </div>
          )}

          {/* related */}
          {related.length > 0 && (
            <div className="related">
              <div className="k">Continue the guide</div>
              <div className="rgrid">
                {related.map((r) => (
                  <Link key={r.meta.slug} className={`rcard${r.meta.featured ? ' pillar' : ''}`} href={`/blog/${r.meta.slug}`}>
                    <div className="e">{r.meta.featured ? '★ Pillar · ' : ''}{PILLARS[r.meta.pillar].label}</div>
                    <h4>{r.meta.title}</h4>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>

        <Toc headings={headings} />
      </div>
    </article>
  )
}
