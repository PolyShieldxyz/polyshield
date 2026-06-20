import type { PostMeta } from '@/lib/blog'
import { P, Answer, H2, PublicPrivate, KeyTerms, Bullets, PrivacyDiagram } from '@/components/blog/BlogKit'

export const meta: PostMeta = {
  slug: 'hide-polymarket-positions',
  title: 'How to Hide Your Polymarket Positions From Trackers',
  subtitle: "Anyone can pull your wallet's full position history. Here's why it's exposed — and how to keep it private.",
  description:
    'Anyone can pull your Polymarket wallet’s full position history. Here’s why it’s exposed and how to keep your active positions private.',
  date: '2026-07-07',
  author: 'PolyShield Team',
  reading_time: '8 min',
  level: 'beginner',
  pillar: 1,
  funnel: 'MOFU',
  primary_keyword: 'hide polymarket positions',
  // published: true,  // ← a team member flips this to publish (drafts are hidden + 404)
  hero_image: {
    src: '/blog/img/hide-polymarket-positions-hero.png',
    alt: 'A public wallet position book on one side and an unlinkable shared account on the other.',
    caption: 'With a shared vault, there is no per-depositor book for a tracker to read.',
  },
  toc: [
    'Yes — your full position history is public',
    "Who's reading your book, and why it costs you",
    "Why the usual fixes don't hide positions",
    'Hiding positions at the protocol level',
  ],
  schema: ['Article', 'FAQPage'],
  related: ['how-to-bet-on-polymarket-privately', 'are-polymarket-trades-public'],
  faq: [
    {
      q: 'Are Polymarket positions public?',
      a: 'Yes. Your open positions, their size, entry price, and full history are visible on-chain to anyone who looks up your wallet address.',
    },
    {
      q: 'Can I hide positions with a new wallet?',
      a: 'Not reliably. A fresh wallet de-anonymizes the moment you fund it or withdraw, because that transfer links it back to you.',
    },
    {
      q: 'Does hiding positions hide my deposit too?',
      a: 'No. The deposit into the vault is public by design. What becomes private is which positions and bets are yours.',
    },
  ],
}

export default function Post() {
  return (
    <>
      <P>
        If you trade with an edge, your open positions are your most valuable secret — and on Polymarket
        they are sitting in the open. Anyone can paste your wallet into a tracker and read your whole book.
      </P>

      <Answer>
        Your Polymarket positions are public: open size, entry price, timing and history are all on-chain
        and tied to your wallet. To hide them, remove the wallet-to-bet link at the protocol level with a
        shared zero-knowledge vault, so every position is held under one account and none is attributable
        to you.
      </Answer>

      <H2>Yes — your full position history is public</H2>
      <P>
        Polymarket settles on a public ledger. For any address, an observer can read every open position,
        the size of each, the entry price, the timing, and the running profit and loss. There is no private
        mode and no &ldquo;hide&rdquo; toggle, because the data lives on the chain itself.
      </P>
      <PublicPrivate
        publicItems={[
          'Your open positions and their size',
          'Entry price and timing of each',
          'Realized and unrealized profit and loss',
          'The wallet address tying it all together',
        ]}
        privateItems={[
          'Which positions are yours, with PolyShield',
          'Your strategy and exposure over time',
        ]}
        note="The deposit remains public — only authorship of positions becomes private."
      />

      <H2>Who&apos;s reading your book, and why it costs you</H2>
      <P>Exposed positions are not a theoretical risk — they are actively mined:</P>
      <Bullets>
        <li>
          <strong>Copy-traders</strong> clone your entries in real time, competing for your fills and
          shrinking your edge.
        </li>
        <li>
          <strong>Counter-traders</strong> fade you once they have profiled your wallet.
        </li>
        <li>
          <strong>Front-runners</strong> watch large public orders and jump ahead of them.
        </li>
        <li>
          <strong>Leaderboards</strong> broadcast your performance whether you want the attention or not.
        </li>
      </Bullets>

      <H2>Why the usual fixes don&apos;t hide positions</H2>
      <P>
        The instinct is to open a new wallet — but a position book is only private until the wallet is
        linked to you, and funding or withdrawing does exactly that. Rotating wallets also fragments your
        own bankroll and still leaves each wallet&apos;s positions fully readable. The exposure is
        structural, so the fix has to be structural too.
      </P>

      <H2>Hiding positions at the protocol level</H2>
      <PrivacyDiagram />
      <P>
        A shared vault flips the model. Many depositors fund one account, and every position is opened from
        that single account. There is no per-depositor book to read, because on-chain there is only one
        trader. An observer sees the vault&apos;s aggregate activity and cannot attribute any single
        position to you. Your privacy scales with how many people share the vault.
      </P>
      <P>
        When you are done, you withdraw <strong>only to your own depositing wallet</strong> — this is a
        private vault, not a mixer. For the complete walkthrough, see{' '}
        <a href="/blog/how-to-bet-on-polymarket-privately">How to bet on Polymarket privately</a>.
      </P>
      <KeyTerms
        terms={[
          ['Anonymity set', '/docs', 'The depositors whose positions are indistinguishable on-chain. Bigger means more private.'],
          ['Withdraw-to-self', '/docs', 'Funds can only return to the depositing wallet — what makes this not a mixer.'],
        ]}
      />
    </>
  )
}
