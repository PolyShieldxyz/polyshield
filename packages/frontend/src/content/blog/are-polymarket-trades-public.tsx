import type { PostMeta } from '@/lib/blog'
import { P, Answer, H2, Bullets, PublicPrivate, KeyTerms, PrivacyDiagram } from '@/components/blog/BlogKit'

export const meta: PostMeta = {
  slug: 'are-polymarket-trades-public',
  title: "Are Polymarket Trades Public? What's Visible and What Isn't",
  subtitle:
    "Polymarket runs on a public ledger — so your bets aren't as private as 'no sign-up' makes them feel.",
  description:
    'Yes — Polymarket trades are public and tied to your wallet. Here’s exactly what anyone can see about your bets, and how to make them private.',
  date: '2026-06-30',
  author: 'PolyShield Team',
  reading_time: '7 min',
  level: 'beginner',
  pillar: 1,
  funnel: 'TOFU',
  primary_keyword: 'are polymarket trades public',
  // published: true,  // ← a team member flips this to publish (drafts are hidden + 404)
  hero_image: {
    src: '/blog/img/are-polymarket-trades-public-hero.png',
    alt: 'A wallet address connected by a line to a public order book, watched by an observer icon.',
    caption:
      'On Polymarket, the address that signs an order is attached to it permanently — so a trade and a trader are one click apart.',
  },
  toc: [
    "What's visible on every trade",
    'Is Polymarket anonymous?',
    "Who's looking, and the tools they use",
    'How to make your trades private',
  ],
  schema: ['Article', 'FAQPage'],
  related: ['how-to-bet-on-polymarket-privately', 'hide-polymarket-positions'],
  faq: [
    {
      q: 'Can people see my Polymarket bets?',
      a: 'Yes. Any of your positions, their size, your entry price and your full history are public on-chain and tied to your wallet address.',
    },
    {
      q: 'Is Polymarket truly anonymous?',
      a: "No — it's pseudonymous. There's no KYC, but your wallet is a permanent identity. Once it's linked to you, your trading history is too.",
    },
    {
      q: 'How do I hide my Polymarket positions?',
      a: 'Break the wallet-to-bet link at the protocol level with a zero-knowledge vault, where every bet is placed from one shared account.',
    },
  ],
}

export default function Post() {
  return (
    <>
      <P>
        Short version: <strong>yes</strong>. Polymarket trades are public and permanently tied to the
        wallet that placed them. There is no sign-up wall, which makes it <em>feel</em> private — but
        &ldquo;no account&rdquo; is not the same as &ldquo;no trace.&rdquo;
      </P>

      <Answer>
        Yes — Polymarket trades are public. Every position, size, entry price, timing and profit or loss
        is recorded on-chain and linked to your wallet address, which anyone can look up. Polymarket is{' '}
        <strong>pseudonymous, not anonymous</strong>: no name, but fully traceable.
      </Answer>

      <H2>What&apos;s visible on every trade</H2>
      <P>
        Polymarket settles on Polygon, a public blockchain. That transparency is great for verifying the
        market is fair — but it means each of these is readable by anyone, for any address, forever:
      </P>
      <PublicPrivate
        publicItems={[
          'Every position you hold and which side you took',
          'The size of each bet, in dollars',
          'Your entry price and exact timing',
          'Your full historical profit and loss',
          'The wallet address behind all of it',
        ]}
        privateItems={[
          'Which depositor authorized which bet',
          'Your running position across markets',
          'The link between your wallet and your trades',
        ]}
        note="The deposit into the vault itself stays public — by design."
      />
      <P>
        That last row is the honest boundary, and we will never blur it: a deposit into the vault is an
        ordinary token transfer and is visible on-chain. What becomes private is <em>which bets are
        yours</em>.
      </P>

      <H2>Is Polymarket anonymous?</H2>
      <P>
        No. It is <strong>pseudonymous</strong>. You do not hand over a name or pass KYC to trade, so it
        feels anonymous — but your wallet address is a stable identity that ties together everything you
        have ever done. Link that address to you once (an exchange withdrawal, an ENS name, a public tip)
        and your entire betting history is retroactively de-anonymized. &ldquo;No KYC&rdquo; is not
        &ldquo;private.&rdquo;
      </P>
      <PrivacyDiagram />

      <H2>Who&apos;s looking, and the tools they use</H2>
      <P>This is not hypothetical. A whole cottage industry watches Polymarket wallets:</P>
      <Bullets>
        <li>
          <strong>Copy-traders</strong> mirror profitable wallets in real time, eroding your edge.
        </li>
        <li>
          <strong>Counter-traders</strong> fade known wallets once they spot a pattern.
        </li>
        <li>
          <strong>Analytics dashboards and leaderboards</strong> rank wallets publicly by profit and loss.
        </li>
        <li>
          <strong>Journalists and researchers</strong> de-anonymize &ldquo;whale&rdquo; wallets for stories.
        </li>
      </Bullets>

      <H2>How to make your trades private</H2>
      <P>
        The naive fixes — a fresh wallet, a VPN — do not hold: the moment you fund or withdraw, the new
        wallet links back to you. Privacy has to happen at the <em>protocol</em> level, by removing the
        wallet-to-bet link entirely. That is what a zero-knowledge vault does: many people deposit into one
        shared account, and every bet is placed from that single account, so an observer can no longer tell
        which bets are yours.
      </P>
      <P>
        For the full walkthrough, read the pillar guide:{' '}
        <a href="/blog/how-to-bet-on-polymarket-privately">How to bet on Polymarket privately</a>.
      </P>
      <KeyTerms
        terms={[
          ['Anonymity set', '/docs', 'The group of depositors whose bets are indistinguishable on-chain. Bigger means more private.'],
          ['Pseudonymous', '/docs', 'Identified by a stable address rather than a name — traceable, not private.'],
          ['Note', '/docs', 'Your private balance in the vault; only an unreadable hash of it ever touches the chain.'],
        ]}
      />
    </>
  )
}
