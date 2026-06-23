---
slug: hide-polymarket-positions
title: How to Hide Your Polymarket Positions From Trackers
subtitle: "Anyone can pull your wallet's full position history. Here's why it's exposed — and how to keep it private."
description: "Anyone can pull your Polymarket wallet's full position history. Here's why it's exposed and how to keep your active positions private."
date: "2026-07-07"
author: PolyShield Team
reading_time: "8 min"
level: beginner
pillar: 1
funnel: MOFU
primary_keyword: hide polymarket positions
# published: true   ← a team member flips this to publish (or run scripts/publish-blog.sh)
hero_image:
  src: /blog/img/hide-polymarket-positions-hero.png
  alt: "A public wallet position book on one side and an unlinkable shared account on the other."
  caption: "With a shared vault, there is no per-depositor book for a tracker to read."
schema: [Article, FAQPage]
related: [how-to-bet-on-polymarket-privately, are-polymarket-trades-public]
faq:
  - q: Are Polymarket positions public?
    a: Yes. Your open positions, their size, entry price, and full history are visible on-chain to anyone who looks up your wallet address.
  - q: Can I hide positions with a new wallet?
    a: Not reliably. A fresh wallet de-anonymizes the moment you fund it or withdraw, because that transfer links it back to you.
  - q: Does hiding positions hide my deposit too?
    a: No. The deposit into the vault is public by design. What becomes private is which positions and bets are yours.
---

If you trade with an edge, your open positions are your most valuable secret — and on Polymarket they are sitting in the open. Anyone can paste your wallet into a tracker and read your whole book.

:::answer
Your Polymarket positions are public: open size, entry price, timing and history are all on-chain and tied to your wallet. To hide them, remove the wallet-to-bet link at the protocol level with a shared zero-knowledge vault, so every position is held under one account and none is attributable to you.
:::

## Yes — your full position history is public

Polymarket settles on a public ledger. For any address, an observer can read every open position, the size of each, the entry price, the timing, and the running profit and loss. There is no private mode and no "hide" toggle, because the data lives on the chain itself.

:::honesty{note="The deposit remains public — only authorship of positions becomes private."}
**Public on-chain (by design)**

- Your open positions and their size
- Entry price and timing of each
- Realized and unrealized profit and loss
- The wallet address tying it all together

**Private with PolyShield**

- Which positions are yours, with PolyShield
- Your strategy and exposure over time
:::

## Who's reading your book, and why it costs you

Exposed positions are not a theoretical risk — they are actively mined:

- **Copy-traders** clone your entries in real time, competing for your fills and shrinking your edge.
- **Counter-traders** fade you once they have profiled your wallet.
- **Front-runners** watch large public orders and jump ahead of them.
- **Leaderboards** broadcast your performance whether you want the attention or not.

## Why the usual fixes don't hide positions

The instinct is to open a new wallet — but a position book is only private until the wallet is linked to you, and funding or withdrawing does exactly that. Rotating wallets also fragments your own bankroll and still leaves each wallet's positions fully readable. The exposure is structural, so the fix has to be structural too.

## Hiding positions at the protocol level

::diagram{name="privacy"}

A shared vault flips the model. Many depositors fund one account, and every position is opened from that single account. There is no per-depositor book to read, because on-chain there is only one trader. An observer sees the vault's aggregate activity and cannot attribute any single position to you. Your privacy scales with how many people share the vault.

When you are done, you withdraw **only to your own depositing wallet** — this is a private vault, not a mixer. For the complete walkthrough, see [How to bet on Polymarket privately](/blog/how-to-bet-on-polymarket-privately).

:::keyterms
- [Anonymity set](/docs): The depositors whose positions are indistinguishable on-chain. Bigger means more private.
- [Withdraw-to-self](/docs): Funds can only return to the depositing wallet — what makes this not a mixer.
:::
