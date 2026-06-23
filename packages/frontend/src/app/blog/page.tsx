import type { Metadata } from 'next'
import Link from 'next/link'
import Image from 'next/image'
import { toCardData, PILLARS, fmtDate, type Pillar } from '@/lib/blog'
import { getPublishedPosts } from '@/lib/blogContent'
import { PostGrid } from '@/components/blog/PostGrid'
import { BlogIndexJsonLd } from '@/components/blog/JsonLd'

export const metadata: Metadata = {
  title: 'Blog — Privacy on Polymarket, Explained | PolyShield',
  description:
    'How Polymarket activity is exposed, why it matters, and how zero-knowledge cryptography makes your bets private. Guides, explainers and the honest limits.',
  alternates: {
    canonical: '/blog',
    types: { 'application/rss+xml': '/blog/rss.xml' },
  },
  openGraph: {
    type: 'website',
    url: '/blog',
    title: 'PolyShield Blog — Privacy on Polymarket, explained',
    description:
      'How Polymarket activity is exposed, why it matters, and how zero-knowledge cryptography makes your bets private.',
  },
}

const PILLAR_ORDER: Pillar[] = [1, 2, 3, 4]

// Reads the content dir at request time; refreshed on publish via /api/revalidate.
export const revalidate = 3600

export default function BlogIndex() {
  const posts = getPublishedPosts()
  const featured = posts.find((p) => p.meta.featured) ?? posts[0]
  const rest = posts.filter((p) => p.meta.slug !== featured?.meta.slug)
  const present = PILLAR_ORDER.filter((n) => posts.some((p) => p.meta.pillar === n)).map((n) => PILLARS[n])
  const cards = rest.map((p) => toCardData(p.meta))

  return (
    <>
      <BlogIndexJsonLd />

      <header className="hero">
        <div className="b-line-grid" />
        <div className="hero-inner">
          <div className="micro" style={{ color: 'var(--brand)' }}>POLYSHIELD BLOG</div>
          <h1>Privacy on Polymarket, explained.</h1>
          <p className="deck">
            Every Polymarket trade is public and tied to your wallet. We write about what that leaks, why
            it matters, and how zero-knowledge cryptography fixes it — in plain language.
          </p>
          <div className="cta-row">
            <a className="btn btn-brand" href="/app/markets">Start trading privately →</a>
            <Link className="btn btn-ghost" href="/how">How it works</Link>
          </div>
        </div>
      </header>

      <div className="b-container">
        {posts.length === 0 && (
          <div className="empty" style={{ marginTop: 40 }}>
            No articles published yet — they&apos;re on the way.{' '}
            <Link className="gold-link" href="/how">See how PolyShield works →</Link>
          </div>
        )}

        {featured && (
          <article className="featured">
            <div className="f-body">
              <span className="pill pill-violet">★ PILLAR GUIDE</span>
              <h2>{featured.meta.title}</h2>
              <p className="deck">{featured.meta.subtitle}</p>
              <div className="meta-row">
                <span className="level">{featured.meta.level}</span><span className="sep">·</span>
                <span>{featured.meta.author}</span><span className="sep">·</span>
                <span>{fmtDate(featured.meta.date)}</span><span className="sep">·</span>
                <span>⏱ {featured.meta.reading_time}</span>
              </div>
              <Link className="gold-link" href={`/blog/${featured.meta.slug}`}>Read the guide →</Link>
            </div>
            <div className="thumb">
              <div className="b-line-grid" />
              <Image
                src={featured.meta.hero_image.src}
                alt=""
                fill
                sizes="(max-width: 860px) 100vw, 520px"
                style={{ objectFit: 'cover' }}
                priority
              />
            </div>
          </article>
        )}

        {cards.length > 0 && <PostGrid posts={cards} pillars={present} />}

        <div className="risk" style={{ marginTop: 8 }}>
          <span className="ic" aria-hidden>⚠</span>
          <span>
            Beta software handling real funds. Not affiliated with Polymarket. Nothing here is investment
            advice. PolyShield hides which depositor authorized which bet — deposits themselves are public
            on-chain.
          </span>
        </div>
      </div>
    </>
  )
}
