---
slug: hide-polymarket-positions
title: "How to Hide Your Polymarket Positions From Trackers"
subtitle: "Your position history is a public dataset. Here's what trackers read, why the usual fixes fail, and how to keep your active book private."
description: "Anyone can pull your Polymarket wallet's full position history. Here's why it's exposed, what trackers see, and how to keep your active positions private."
date: "2026-06-30"
author: PolyShield Team
reading_time: "8 min"
level: beginner
pillar: 1
funnel: MOFU
primary_keyword: hide polymarket positions
secondary_keywords: [hide polymarket trades, are my polymarket positions visible, stop people copying my polymarket bets]
hero_image:
  src: /blog/img/hide-polymarket-positions-hero.png
  alt: "Two-panel 'vs' card: 'Trading directly — every position public forever' versus 'PolyShield — which bet was yours, unlinkable on-chain.'"
  caption: "Same bets, two very different public footprints."
og:
  title: "How to Hide Your Polymarket Positions From Trackers"
  description: "Your full position history is on-chain and readable in real time. Why new wallets and VPNs don't hide it — and what actually does."
  image: /blog/img/hide-polymarket-positions-hero.png
  type: article
twitter:
  card: summary_large_image
  title: "How to Hide Your Polymarket Positions"
  description: "Whale trackers read your book in real time. New wallets leak. Here's how to make your positions unlinkable to your wallet."
  image: /blog/img/hide-polymarket-positions-hero.png
schema: [Article, FAQPage]
canonical: /blog/hide-polymarket-positions
related: [how-to-bet-on-polymarket-privately, are-polymarket-trades-public]
published: true
---

If you trade size on Polymarket, your positions aren't just yours — they're a public dataset. Wallet-tracking tools exist for exactly one reason: your full position history is sitting on-chain, readable by anyone, in real time. This guide covers what's exposed, why the usual fixes don't hide *positions*, and how to keep your active book private.

:::answer
Your Polymarket positions are public — open size, entry price, timing, and full history are all on-chain and tied to your wallet, which is exactly what whale-trackers read. To hide them, remove the wallet-to-bet link at the protocol level with a shared zero-knowledge vault, so every position is held under one account and none is attributable to you. Your deposit stays public by design.
:::

## Yes — your position history is public

On Polymarket, every position is recorded on Polygon and tied to the wallet that opened it. Pull up any address and you can read:

- which markets it's in, and which side (YES/NO);
- the **size** of each position;
- the **entry price** and the **timestamp** of every buy and sell;
- the complete lifetime history of that wallet.

A "whale tracker" isn't doing anything clever — it's just indexing public data and putting a nice UI on it. The exposure is the default state of trading directly. (For the full inventory of what leaks, see [Are Polymarket trades public?](/blog/are-polymarket-trades-public))

## Who's reading your book, and why it costs you

Three groups benefit when your positions are visible, all at your expense:

- **Copy-traders** mirror your entries. If you found an edge, they get it for free — and the crowding moves the price against you.
- **Counter-traders** see a large directional position and trade against it deliberately.
- **Front-runners** watch your order flow and get ahead of your next move, worsening your fills.

The common thread: the *information* is the leak. A position nobody can see can't be copied, faded, or front-run.

### Why "trade smaller / trade quieter" doesn't save you

The intuitive response is to make yourself less conspicuous — smaller clips, odd hours, spreading a position across entries. It doesn't work, because every one of those clips is still a public position tied to your wallet. Splitting a 50k position into ten 5k buys just produces ten visible buys from the same address, and chain-analysis stitches them back together. You can't out-quiet a ledger that records everything.

## Why the usual fixes don't hide positions

**New wallet per position.** It hides nothing once you fund it (the funding tx links it) or once you withdraw winnings to a known address. And managing a maze of wallets is its own operational risk.

**A VPN or a "burner" email.** These touch your *network identity*, not your *on-chain* footprint. The position is still public on Polygon.

**Manual obfuscation.** Timing tricks, hops, and splits are high-effort and fragile — and they leave the position itself attached to a public address.

Every one of these leaves the position attached to a public wallet. To actually hide the position, the bet has to be placed by something other than your wallet.

## Hide positions at the protocol level

::diagram{name="privacy"}

That's what a zero-knowledge **privacy vault** does. With [PolyShield](/how):

- many depositors share **one vault**, and the vault holds **one Polymarket account**;
- every bet is placed by that single shared account;
- on-chain, the positions all belong to the vault, and **which depositor is behind any given position is unlinkable** — enforced by zero-knowledge proofs, not by trust.

A tracker pointed at the vault sees one busy account, not your book. There's no per-depositor position to copy, fade, or front-run, because the link from a position back to a depositor isn't on the chain.

### Before vs. after

| | Trading directly | Via a privacy vault |
|---|---|---|
| Your positions visible per wallet | Yes | No — held by the shared account |
| Size and entry price readable | Yes | Not linkable to you |
| Copy-traders can mirror you | Yes | No individual book to mirror |
| Your deposit visible | Yes | Yes (public by design) |

## The honest boundary

A privacy vault does **not** hide that your wallet deposited, or how much — a deposit is an ordinary on-chain USDC transfer, and it's public on purpose. What becomes unlinkable is *which position is yours*.

:::honesty{note="The deposit itself stays public — by design."}
**Public on-chain (by design)**

- That your wallet deposited, and the amount
- Every position the vault holds, its size and entry price

**Private with PolyShield**

- Which depositor authorized which position
- Your running strategy and exposure over time
:::

PolyShield is **not a mixer**, and withdrawals only ever return to your own depositing wallet. Stating that limit plainly is the point: privacy you can verify beats privacy you're asked to take on faith.

:::keyterms
- [Anonymity set](/how): The depositors whose positions are indistinguishable on-chain — bigger means more private.
- [Withdraw-to-self](/how): Funds can only return to the depositing wallet — what makes this a vault, not a mixer.
:::

→ See the full flow: **[How to bet on Polymarket privately](/blog/how-to-bet-on-polymarket-privately)** · or the full inventory of what leaks in **[Are Polymarket trades public?](/blog/are-polymarket-trades-public)**.

## FAQ

**Are my Polymarket positions visible to others?**
Yes. Position, side, size, entry price, and timing are public on-chain per wallet, which is exactly what wallet-tracking tools display.

**How do I hide my Polymarket positions?**
Route bets through a zero-knowledge privacy vault so they're placed by one shared account. Individual positions can't be linked back to your wallet on-chain. Your deposit remains public.

**Will a new wallet hide my positions?**
Not reliably. Funding and withdrawals link a new wallet to your existing ones, so chain-analysis can reconnect the positions.

**Does hiding positions also hide my deposit?**
No. A deposit into the vault is public by design, including the amount. What's hidden is which bet or position a depositor authorized.
