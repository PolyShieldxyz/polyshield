import type { PostMeta } from '@/lib/blog'
import { P, Answer, H2, PublicPrivate, KeyTerms, Steps, Bullets, LifecycleDiagram } from '@/components/blog/BlogKit'

export const meta: PostMeta = {
  slug: 'how-to-bet-on-polymarket-privately',
  title: 'How to Bet on Polymarket Privately (2026 Guide)',
  subtitle: "The complete, non-custodial guide to placing Polymarket bets that aren't tied to your wallet.",
  description:
    'Every Polymarket trade is public and tied to your wallet. Here’s how to place bets privately with a zero-knowledge vault — step by step, non-custodial.',
  date: '2026-07-02',
  author: 'PolyShield Team',
  reading_time: '12 min',
  level: 'beginner',
  pillar: 1,
  funnel: 'Commercial',
  primary_keyword: 'how to bet on polymarket privately',
  featured: true,
  // published: true,  // ← a team member flips this to publish (see registry.ts / docs/blog-design.md)
  hero_image: {
    src: '/blog/img/how-to-bet-on-polymarket-privately-hero.png',
    alt: 'Three wallets depositing into one shared PolyShield vault that places all bets from a single account.',
    caption: 'Many depositors, one shared account: the structure that hides which bets are yours.',
  },
  toc: [
    'What "private" actually means here',
    'Why the naive options fall short',
    'The shared-anonymity-set approach',
    'Step by step',
    'The honest limits',
  ],
  schema: ['Article', 'FAQPage', 'HowTo'],
  related: ['are-polymarket-trades-public', 'hide-polymarket-positions'],
  faq: [
    {
      q: 'Is betting privately on Polymarket legal?',
      a: 'Using a privacy tool is not the same as evading rules. PolyShield is about unlinkability on a public ledger, not evading KYC, sanctions, or geo-restrictions. Always follow the laws that apply to you.',
    },
    {
      q: 'Is this a mixer?',
      a: 'No. PolyShield is withdraw-to-self only: funds can only return to the wallet that deposited them, enforced inside the ZK circuit and re-checked on-chain. A mixer breaks the link between a sender and an arbitrary recipient; PolyShield does not.',
    },
    {
      q: 'Do I have to back up a secret?',
      a: 'No. Note secrets are derived from your wallet signature, so your wallet is your backup. On a new device, one signature reconstructs every note.',
    },
    {
      q: 'What does it cost?',
      a: 'There is a 0.3% bet fee (plus a small ~$0.15 relay reimbursement) and a flat $1 withdrawal fee, all taken in USDC. It is beta software handling real funds, with a $50,000 per-address deposit cap in the current phase.',
    },
  ],
}

export default function Post() {
  return (
    <>
      <P>
        If you have read that{' '}
        <a href="/blog/are-polymarket-trades-public">Polymarket trades are public</a>, the obvious next
        question is what to actually do about it. This guide walks the whole round trip — deposit, bet,
        settle, withdraw — and is honest about the limits.
      </P>

      <Answer>
        To bet on Polymarket privately, deposit USDC into a shared zero-knowledge vault, then authorize
        each bet with a proof generated in your browser. Every bet is placed from the vault&apos;s single
        account, so no observer can link a bet to your wallet. You withdraw only to your own depositing
        wallet.
      </Answer>

      <H2>What &quot;private&quot; actually means here</H2>
      <P>
        This is the most important section, so we lead with it. PolyShield protects{' '}
        <strong>which depositor authorized which bet</strong> — it does <em>not</em> hide that a wallet
        deposited into the vault. A deposit is an ordinary token transfer and is public on-chain. Privacy
        here means <strong>unlinkability</strong>, not anonymity or evasion: your bets are
        cryptographically separated from your identity, but you are not hiding that you exist or dodging
        any rule.
      </P>
      <PublicPrivate
        publicItems={[
          'That some wallet deposited into the vault, and how much',
          "The vault's single account and all of its bets",
          "Every market's outcome and payout",
        ]}
        privateItems={[
          'Which depositor authorized which bet',
          'Your running position and strategy',
          'The link between your wallet and your trades',
        ]}
        note="Deposits are deliberately public — faking them would mean lying about custodied money."
      />

      <H2>Why the naive options fall short</H2>
      <P>Most do-it-yourself privacy breaks the moment money moves:</P>
      <Bullets>
        <li>
          <strong>A fresh wallet</strong> still links to you the instant you fund it or cash out.
        </li>
        <li>
          <strong>A VPN</strong> hides your IP, not the on-chain wallet-to-bet link — which is the actual
          leak.
        </li>
        <li>
          <strong>Manual funding tricks</strong> are fragile, leak timing, and break under chain analysis.
        </li>
      </Bullets>
      <P>
        The leak is structural: on a public order book, the address that signs an order is bound to it
        forever. You have to remove that link at the protocol level.
      </P>

      <H2>The shared-anonymity-set approach</H2>
      <P>
        PolyShield pools many depositors into one vault that owns a <strong>single</strong> Polymarket
        account. Every bet — yours and everyone else&apos;s — is placed from that one account. On-chain
        there is a single stream of orders from one trader, and nothing says which depositor stands behind
        each one. Your privacy grows with the crowd: the more active depositors, the larger the set your
        bet hides in.
      </P>
      <LifecycleDiagram />

      <H2>Step by step</H2>
      <Steps
        items={[
          <>
            <strong>Connect</strong> your wallet on Polygon and <strong>deposit USDC</strong>. Your browser
            creates a private note and a mandatory deposit-binding proof that ties the note&apos;s balance
            to exactly what you transferred.
          </>,
          <>
            <strong>Hold the note.</strong> It lives only in your browser; its secret is derived from a
            wallet signature, so there is nothing to write down.
          </>,
          <>
            <strong>Authorize a bet</strong> with a zero-knowledge proof. The proof relay submits it for
            you, so your wallet is never the sender and the bet can&apos;t be traced to you.
          </>,
          <>
            <strong>Settle</strong> when the market resolves. The payout arrives as a fresh private note;
            the vault reads the official payout on-chain so nothing can be inflated.
          </>,
          <>
            <strong>Withdraw to yourself.</strong> Funds can return only to your depositing wallet —
            enforced by the circuit, then re-checked on-chain.
          </>,
        ]}
      />

      <H2>The honest limits</H2>
      <Bullets>
        <li>
          It is <strong>beta software handling real funds</strong>. Treat it accordingly.
        </li>
        <li>
          There is a <strong>$50,000</strong> per-address deposit cap in the current phase.
        </li>
        <li>
          Proof generation runs in your browser and can take <strong>30 seconds to a couple of minutes</strong>.
        </li>
        <li>
          Privacy is <strong>relative to the anonymity set</strong> — a small set is weaker than a large one.
        </li>
        <li>
          The one real trust assumption is the contract <strong>upgrade key</strong> (a multisig in
          production); it cannot redirect your funds away from your own wallet.
        </li>
      </Bullets>
      <KeyTerms
        terms={[
          ['Anonymity set', '/docs', 'The depositors whose bets are indistinguishable on-chain. Bigger means more private.'],
          ['Note', '/docs', 'Your private balance in the vault; only an unreadable hash of it touches the chain.'],
          ['Withdraw-to-self', '/docs', 'The rule that funds can only return to the depositing wallet — what makes this not a mixer.'],
        ]}
      />
    </>
  )
}
