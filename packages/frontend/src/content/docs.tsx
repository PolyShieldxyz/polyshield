// Documentation content — the section/page tree with full prose bodies. Lives apart
// from the route component so every doc page can be a real, server-rendered,
// deep-linkable URL (/docs/[slug]) instead of client-only tab state. DocKit primitives
// are client components; embedding them in these element trees is fine — the [slug]
// server page renders them and they hydrate on the client.
import type { ReactNode } from 'react'
import {
  Lead, P, H3, Code, Pre, Bullets, Steps, Callout, Term,
  PrivacyDiagram, LifecycleDiagram, NoteDiagram, MerkleDiagram,
  ZkProofDiagram, ArchitectureDiagram, SpendDiagram, PredictionMarketDiagram,
  AccountVsNotesDiagram,
} from '@/components/docs/DocKit'

type RawDocPage = { title: string; body: ReactNode }

const SECTIONS: Record<string, RawDocPage[]> = {
  'Getting started': [
    {
      title: 'Overview',
      body: (
        <>
          <Lead>
            PolyShield is a zero-knowledge privacy vault for Polymarket, live on Polygon mainnet. It lets you
            bet on Polymarket without your wallet ever appearing on the trade — while keeping full,
            self-custodial control of your money.
          </Lead>
          <P>
            Polymarket runs on a <strong>public</strong> order book. Every order, fill, and settlement is
            permanently on-chain and tied to the address that signed it. Anyone — an analytics firm, a
            counterparty, a journalist — can pull your wallet&apos;s entire betting history and net position. For
            most traders that linkage is the privacy problem.
          </P>
          <P>
            PolyShield breaks the link. Many people deposit into one shared vault. The vault owns a{' '}
            <strong>single</strong> Polymarket account, and every bet is placed by that one account. On-chain,
            all bets look like they come from the same trader. Which depositor is actually behind any given bet
            is hidden by cryptography, not by a promise.
          </P>
          <PrivacyDiagram />
          <H3>What PolyShield hides — and what it doesn&apos;t</H3>
          <Term rows={[
            ['Hidden', <>which depositor authorized which bet, and your running position. This is the property the cryptography enforces.</>],
            ['Public', <>that <em>some</em> wallet deposited into the vault, and how much. A deposit is an ordinary ERC-20 transfer — visible by design.</>],
          ]} />
          <Callout title="The privacy boundary" tone="gold">
            Think of PolyShield as a members-only trading desk. The world can see you walked in the door (the
            deposit). It cannot see which trades on the desk&apos;s shared account are yours.
          </Callout>
          <P>
            Everything privacy-sensitive — generating your note, building every proof — happens locally in your
            browser with WebAssembly. No secret ever leaves your device, and no PolyShield server can link a bet
            back to a depositor, even if it wanted to.
          </P>
        </>
      ),
    },
    {
      title: 'The basics',
      body: (
        <>
          <Lead>
            New to crypto or prediction markets? Start here. This page explains the everyday ideas the rest of
            the docs build on — no prior knowledge assumed.
          </Lead>

          <H3>Prediction markets &amp; Polymarket</H3>
          <P>
            A prediction market lets people bet on the outcome of a real-world question — an election, a sports
            result, &quot;will this happen by Friday?&quot; <strong>Polymarket</strong> is the largest such market.
            Instead of traditional odds, you buy <strong>shares</strong> in an outcome.
          </P>
          <PredictionMarketDiagram />
          <P>
            The price of a share <em>is</em> the market&apos;s estimate of the odds: a YES share at 63¢ means the
            crowd thinks the event is about 63% likely. If you&apos;re right, every share you hold settles to{' '}
            <strong>$1.00</strong>; if you&apos;re wrong, it&apos;s worth <strong>$0</strong>. Buy low on an outcome you
            believe in, and the gap between what you paid and $1 is your profit.
          </P>

          <H3>Wallets, addresses &amp; USDC</H3>
          <Term rows={[
            ['Wallet', <>Your crypto account — software like MetaMask that holds your keys. You <strong>sign</strong>{' '}
              with it to approve actions, the way you&apos;d sign a cheque.</>],
            ['Address', <>Your wallet&apos;s public ID (a string like <Code>0x1a2b…</Code>). Anyone can look up
              everything an address has ever done — that public visibility is exactly the privacy problem
              PolyShield solves.</>],
            ['USDC', <>A <strong>stablecoin</strong>: a digital dollar that always aims to be worth $1. It&apos;s the
              only money PolyShield takes in and pays out.</>],
          ]} />

          <H3>&quot;On-chain&quot; — and why it&apos;s all public</H3>
          <P>
            A blockchain like <strong>Polygon</strong> is a shared public ledger. Every transaction is recorded
            permanently and visibly, tagged with the address that made it. That transparency is great for
            trust — but it means a normal Polymarket bet is forever linked to your wallet for anyone to see.
            PolyShield keeps the transparency (everything is still verifiable on-chain) while hiding the one
            link that matters: <em>which bet is yours.</em>
          </P>

          <H3>Gas</H3>
          <P>
            Every on-chain action costs a small network fee called <strong>gas</strong>, paid in the chain&apos;s
            native token. With PolyShield you don&apos;t pay gas on your bets at all — the proof relay submits them
            and covers the gas for you (which is also what keeps your wallet off the transaction). The only time
            your wallet itself acts on-chain is the initial deposit.
          </P>
          <Callout title="Where PolyShield fits" tone="gold">
            Put simply: you deposit USDC, bet on Polymarket through a shared account so no one can tell the bet
            is yours, and withdraw your winnings back to your own wallet — with cryptography, not trust, keeping
            you private the whole way.
          </Callout>
        </>
      ),
    },
    {
      title: 'Quickstart',
      body: (
        <>
          <Lead>The whole round trip, end to end. Money enters once and only ever leaves to the wallet that put it in.</Lead>
          <LifecycleDiagram />
          <Steps items={[
            <><strong>Connect</strong> your EVM wallet on Polygon mainnet.</>,
            <><strong>Deposit USDC.</strong> Your browser generates a private spending note and a mandatory
              deposit-binding proof that ties the note&apos;s balance to the exact amount you transferred — so you
              can never commit more than you paid in.</>,
            <><strong>Hold the note.</strong> The note <Code>(secret, balance, nonce, owner_address)</Code> lives
              only in your browser. The secret is derived from a wallet signature, so there is nothing to write
              down or back up.</>,
            <><strong>Place a bet.</strong> Browse live markets and authorize a bet with a <Code>BET_AUTH</Code> proof.
              The proof relay submits it on your behalf — your wallet is never the sender, so the bet can&apos;t be
              traced to you.</>,
            <><strong>Settle.</strong> When the market resolves, claim winnings with a one-click
              settlement-credit proof. The payout arrives as a fresh private note.</>,
            <><strong>Withdraw</strong> to your own address with a withdrawal proof. Withdrawals are
              wallet-to-wallet only: funds can return solely to the depositing wallet.</>,
          ]} />
          <Callout title="New device?" tone="info">
            Click <strong>Recover notes</strong>. The app rebuilds your full note set from one wallet signature
            plus the public backend index — no chain scan, no seed phrase, nothing to import.
          </Callout>
        </>
      ),
    },
    {
      title: 'FAQ',
      body: (
        <>
          <H3>Is this a mixer?</H3>
          <P>
            No. A mixer breaks the link between a sender and an arbitrary recipient. PolyShield is{' '}
            <strong>withdraw-to-self only</strong> — your money can only come back to the wallet that deposited
            it. The vault hides <em>which bets are yours</em>, not <em>where your money goes</em>.
          </P>
          <H3>Can PolyShield steal my funds?</H3>
          <P>
            It cannot move your balance to anyone but you — withdrawal-to-self is enforced inside the ZK circuit
            and re-checked on-chain. The one real trust assumption is the contract <strong>upgrade key</strong>,
            which can replace contract logic; in production that key is a multisig/HSM. See{' '}
            <em>Security → Trust assumptions</em>.
          </P>
          <H3>What if I lose my browser data?</H3>
          <P>
            Your notes are recoverable from your wallet alone. Secrets are derived deterministically from wallet
            signatures, so a single signature on a new device reconstructs every note. The only unrecoverable
            loss is losing the depositing <strong>wallet</strong> itself — there is no admin override.
          </P>
          <H3>Can I withdraw while I still have open bets?</H3>
          <P>
            Yes. You can withdraw your free balance any time, and a withdrawal can never strand an open bet&apos;s
            payout: if withdrawing would empty a deposit that still holds an open position, the app keeps a
            fraction of a cent behind so that position&apos;s payout can still be claimed later. To cash out
            everything at once, use <strong>Settle &amp; Withdraw</strong> on the Withdraw screen — it settles
            every resolved bet, sells your open positions at the current market price, reclaims any unfilled
            orders, then withdraws your full balance in one flow.
          </P>
          <H3>Does the operator see my bets?</H3>
          <P>
            The operator sees ZK proofs and public inputs — never a depositor identity. (One opt-in exception:
            auto-settlement, where you may hand the operator an encrypted blob so it can settle for you. It
            links you to that one bet at the operator level and nothing more.)
          </P>
          <H3>How long does a proof take?</H3>
          <P>
            Typically 30 seconds to ~2 minutes in-browser, depending on your device. Keep the tab open while it
            runs — proving is CPU-bound and local.
          </P>
        </>
      ),
    },
  ],

  'Core concepts': [
    {
      title: 'The privacy model',
      body: (
        <>
          <Lead>
            PolyShield&apos;s privacy comes from a <strong>shared anonymity set</strong>, not from hiding that you
            use it. Understanding what that set is — and isn&apos;t — is the most important concept here.
          </Lead>
          <PrivacyDiagram />
          <H3>One account, many authors</H3>
          <P>
            The vault holds exactly one Polymarket signing account (an EOA). When you authorize a bet, the
            signing layer places it from that account. So does everyone else&apos;s. On-chain there is a single
            stream of orders from one trader, and no field anywhere says which depositor stands behind each one.
          </P>
          <P>
            Your privacy is therefore <strong>relative to the crowd</strong>. With three depositors, an observer
            knows your bet is one of three. With three thousand active depositors, it&apos;s one of three thousand.
            The set grows as the vault is used — this is the same anonymity-set principle behind every serious
            privacy protocol.
          </P>
          <H3>The deposit is the deliberate leak</H3>
          <P>
            PolyShield does not try to hide that a wallet deposited, or how much. That&apos;s an ordinary token
            transfer and faking it would mean lying about money the contract custodies. Instead, the design
            ensures the deposit reveals <em>nothing about your future bets</em> — the link from deposit to bet
            is what the zero-knowledge machinery severs.
          </P>
          <Callout title="The one client rule" tone="warn">
            All spend transactions must be submitted by the relay, never your own wallet. If you called a spend
            function directly, your wallet would appear as the transaction sender and de-anonymize that action.
            The frontend always routes through the relay — this is the single discipline the privacy model
            depends on at the client.
          </Callout>
        </>
      ),
    },
    {
      title: 'Zero-knowledge proofs',
      body: (
        <>
          <Lead>
            A zero-knowledge proof lets you prove a statement is true while revealing nothing beyond the fact
            that it&apos;s true. It&apos;s the engine that lets PolyShield verify your bets without learning who you are.
          </Lead>
          <P>
            The classic analogy: proving you&apos;re over 21 without showing your birthday — or even your age. The
            bouncer becomes convinced, learns nothing else, and can&apos;t reuse what they saw to identify you later.
          </P>
          <ZkProofDiagram />
          <H3>What your proofs actually claim</H3>
          <P>Every PolyShield action is a small, specific statement proven in-browser. For a bet, you prove:</P>
          <Bullets items={[
            <>&quot;I know the secret behind a note that exists in the vault&apos;s Merkle tree&quot; — <em>without revealing which note.</em></>,
            <>&quot;That note&apos;s balance is at least the bet amount plus the fee&quot; — <em>without revealing the balance.</em></>,
            <>&quot;Here is the correct nullifier and the correct new note&quot; — so the math can be checked but not traced.</>,
          ]} />
          <P>
            The Vault verifies the proof on-chain in milliseconds. If even one claim is false, verification
            fails and the transaction reverts. There is no way to forge a valid proof for a false statement.
          </P>
          <H3>The stack</H3>
          <Term rows={[
            ['Circuits', <>9 circuits written in <strong>Circom</strong>, one per action, compiled to WebAssembly.</>],
            ['Proving', <><strong>Groth16</strong> over the BN254 curve via snarkjs — fast to verify, tiny proofs.</>],
            ['Hashing', <><strong>Poseidon</strong>, a hash designed to be cheap inside circuits (Keccak would be enormous here).</>],
            ['Where', <>Proving runs <strong>client-side</strong>; verification runs on-chain in snarkjs-generated verifier contracts.</>],
          ]} />
        </>
      ),
    },
    {
      title: 'Spending notes',
      body: (
        <>
          <Lead>
            PolyShield doesn&apos;t track your money as a balance in an account. It holds it as <strong>notes</strong> —
            private records you keep, where only an unreadable fingerprint of each one ever touches the chain.
          </Lead>
          <H3>Why notes instead of a balance?</H3>
          <P>
            Almost everything you know — your bank, an exchange, even an everyday crypto wallet — uses an{' '}
            <strong>account</strong>: a single running balance, one number that ticks up and down. PolyShield
            works more like <strong>physical cash</strong>. Your money is a handful of discrete notes, each worth
            a fixed amount, and your balance is simply their sum. (If you&apos;ve heard of Bitcoin&apos;s &quot;UTXO&quot; model,
            this is the same idea.)
          </P>
          <AccountVsNotesDiagram />
          <P>
            That difference is the whole point for privacy. A running balance is one long-lived record that&apos;s
            easy to watch over time. Notes are disposable: every time you spend, the note you used is{' '}
            <strong>destroyed for good</strong> and a brand-new note is minted for the change — with a fresh,
            unlinkable identity. There&apos;s no persistent account for an observer to follow.
          </P>
          <Callout title="You never juggle notes by hand" tone="info">
            The app picks and splits notes for you automatically. The model is what makes the privacy work — but
            day to day you just see a single balance, like in any normal app.
          </Callout>
          <H3>What&apos;s inside a note</H3>
          <P>
            A note is four pieces of information. Picture it as a sealed envelope: the vault takes the sealed
            envelope and keeps only a tamper-evident stamp of it, never the contents.
          </P>
          <NoteDiagram />
          <Term rows={[
            ['secret', 'a random value derived from your wallet signature; the key to spending the note.'],
            ['balance', 'the USDC the note is worth, in micro-units (6 decimals).'],
            ['nonce', 'a counter that increments every time you spend, so each spend is distinct.'],
            ['owner_address', 'your depositing wallet, as a field element. This is what pins withdrawals to you.'],
          ]} />
          <H3>Two derived values</H3>
          <P>From those fields the circuit derives two things that matter on-chain:</P>
          <Pre>{`commitment  C = Poseidon4(secret, balance, nonce, owner_address)
nullifier   N = Poseidon2(secret, nonce)`}</Pre>
          <Bullets items={[
            <>The <strong>commitment</strong> is the public fingerprint stored as a leaf in the Merkle tree. It
              reveals nothing — you can&apos;t recover the balance or owner from it.</>,
            <>The <strong>nullifier</strong> is published only when you spend, to mark the note as used. Crucially
              it&apos;s built from just <Code>secret</Code> and <Code>nonce</Code> — not balance or owner — so it can&apos;t
              be correlated to a deposit amount or address.</>,
          ]} />
          <Callout title="Nothing to back up" tone="info">
            The secret is re-derived from your wallet on demand, so notes are never stored in plaintext anywhere
            and there is no seed phrase. The encrypted note cache in your browser is a convenience; your wallet
            is the real backup.
          </Callout>
        </>
      ),
    },
    {
      title: 'The Merkle tree & nullifiers',
      body: (
        <>
          <Lead>
            Two on-chain structures do all the bookkeeping: a <strong>Merkle tree</strong> that proves a note
            exists, and a <strong>nullifier registry</strong> that stops it from being spent twice.
          </Lead>
          <H3>The Merkle tree — &quot;my note is real&quot;</H3>
          <P>
            Every note commitment is appended as a leaf to one giant tree (depth 32 — room for billions of
            notes). The tree hashes pairs of nodes upward until a single <strong>root</strong> summarizes the
            whole set. To prove your note exists, you reveal the chain of sibling hashes from your leaf to the
            root — the <em>inclusion path</em> — without revealing which leaf you are.
          </P>
          <MerkleDiagram />
          <P>
            Because the root changes with every deposit, PolyShield accepts a rolling window of the last{' '}
            <strong>1024 roots</strong>. A proof you started building a few blocks ago still verifies against the
            root that was current when you fetched your path — so you&apos;re never racing the chain.
          </P>
          <H3>Nullifiers — &quot;and I haven&apos;t spent it&quot;</H3>
          <P>
            Proving a note exists isn&apos;t enough — you could try to spend the same note repeatedly. Each spend
            publishes the note&apos;s nullifier, which the Vault records in a registry. Spend the same note again and
            its nullifier is already present, so the transaction reverts. The nullifier is checked{' '}
            <em>before</em> any state change (checks-effects-interactions), closing double-spend.
          </P>
          <SpendDiagram />
          <P>
            This is why spending always mints a fresh note: you can&apos;t edit a note in place, because the old one
            is permanently nullified. The leftover balance flows into a new note with a new nonce, a new
            commitment, and — importantly — a new, unlinkable nullifier for next time.
          </P>
        </>
      ),
    },
  ],

  'Architecture': [
    {
      title: 'System overview',
      body: (
        <>
          <Lead>PolyShield is four layers, each with a deliberately narrow trust role. The privacy guarantee
            survives even if the two off-chain services are fully compromised.</Lead>
          <ArchitectureDiagram />
          <Term rows={[
            ['Your browser', <>Holds the wallet-derived secret and generates every proof in WASM. The <strong>only</strong> party
              that can link a wallet to a note.</>],
            ['Proof relay', <>Submits your proofs to the Vault and pays the gas, so your wallet is never the
              transaction sender. Doubles as the backend index. Cannot forge proofs or de-anonymize anyone.</>],
            ['Signing layer', <>Holds the vault EOA, places CLOB orders, resolves settled markets, and funds
              collateral just-in-time. Centralized in v1; an AWS Nitro TEE in v2.</>],
            ['On-chain', <>The Vault (UUPS proxy), its Merkle tree, nullifier registry, and 9 Groth16 verifiers.
              The source of truth — trustless except the owner upgrade key.</>],
          ]} />
          <Callout title="Why this split matters" tone="gold">
            Privacy doesn&apos;t depend on trusting the relay or signing layer. They only ever handle ZK proofs and
            public inputs — no secret passes through them. And the on-chain rules block theft, double-spend, and
            forged credits no matter who submits the transaction.
          </Callout>
        </>
      ),
    },
    {
      title: 'Vault contract',
      body: (
        <>
          <Lead>
            <Code>Vault.sol</Code> on Polygon mainnet is the trust anchor — a UUPS-upgradeable contract behind an
            ERC-1967 proxy. It custodies funds and enforces every rule.
          </Lead>
          <P>The Vault:</P>
          <Bullets items={[
            <>Maintains the append-only <strong>Poseidon Merkle tree</strong> (depth 32) of note commitments.</>,
            <>Records spent <strong>nullifiers</strong> to prevent double-spend, checks-effects-interactions throughout.</>,
            <>Verifies 9 proof types: <Code>DEPOSIT</Code>, <Code>BET_AUTH</Code>, <Code>SETTLEMENT_CREDIT</Code>,{' '}
              <Code>WITHDRAWAL</Code>, <Code>BET_CANCEL</Code>, <Code>CANCEL_CREDIT</Code>, <Code>POSITION_CLOSE</Code>,{' '}
              <Code>PARTIAL_CREDIT</Code>, <Code>CONSOLIDATE</Code>.</>,
            <>Derives settlement payouts <strong>on-chain</strong> from the real Gnosis CTF and injects them into
              proofs — users never supply a payout value, so they can&apos;t inflate a credit.</>,
            <>Enforces a <strong>$50,000</strong> per-address cumulative deposit cap in the MVP.</>,
            <>Holds a governance-mutable fee config (bet fee, withdrawal fee, relay-gas reimbursement).</>,
          ]} />
          <H3>Injected values: the anti-forgery pattern</H3>
          <P>
            For anything a user shouldn&apos;t control — the fee, the payout-per-share, the cancellation amount — the
            Vault supplies the value as a public input to the proof. Because that value feeds the new
            commitment, a proof built with any other number simply fails verification. The user proves the math;
            the Vault dictates the sensitive terms.
          </P>
          <Callout title="Under the size limit" tone="info">
            A Solidity contract can&apos;t exceed 24&nbsp;KB. The Vault stays under it by delegatecall-linking two
            libraries — <Code>VaultInputs</Code> (public-input assembly) and <Code>VaultLogic</Code> (spend-path
            bodies) — which run in the Vault&apos;s own storage context.
          </Callout>
        </>
      ),
    },
    {
      title: 'ZK circuits',
      body: (
        <>
          <Lead>
            There are nine circuits — one for each kind of action you can take. A circuit is just a tiny program
            that checks a single, specific claim is true. Here is what each one does, in plain English. No math
            required.
          </Lead>
          <P>
            Each runs in your browser, takes a few seconds to a couple of minutes, and produces a small proof
            the Vault can check on-chain. You never see most of them — they fire automatically as you deposit,
            bet, and settle.
          </P>

          <H3>Putting money in</H3>
          <P>
            <strong>Deposit.</strong> The moment you add USDC, this proof guarantees the private note you receive
            is worth <em>exactly</em> what you put in — not a cent more. It&apos;s the safety catch on the whole
            system: without it, someone could deposit $1 and claim a $1,000 note, draining the shared pool. It
            also stamps the note with your wallet, which is what later lets only you withdraw.
          </P>

          <H3>Placing a bet</H3>
          <P>
            <strong>Bet authorization.</strong> The workhorse you trigger every time you bet. In one shot it
            proves three things: that you genuinely own a note sitting in the vault, that the note holds enough
            to cover the bet plus the small fee, and that the leftover change is correctly recorded as a fresh
            note — all <em>without</em> revealing which note is yours or how much it held. This is the proof that
            lets you bet privately.
          </P>

          <H3>Collecting a win</H3>
          <P>
            <strong>Settlement credit.</strong> When a market resolves and you backed the winning side, this
            claims your payout. You prove you held the winning position; the Vault itself looks up the official
            payout from Polymarket&apos;s settlement contracts and fills in the numbers, so no one can exaggerate
            their winnings. Your money arrives as a new private note.
          </P>

          <H3>Taking money out</H3>
          <P>
            <strong>Withdrawal.</strong> Turns a note back into real USDC. It proves you own the note <em>and</em>{' '}
            that the destination is your own depositing wallet — the funds physically cannot be sent anywhere
            else. This is the rule that makes PolyShield a private vault rather than a mixer.
          </P>

          <H3>When an order doesn&apos;t fully go through</H3>
          <P>
            <strong>Bet cancel.</strong> Some orders are all-or-nothing; if the market can&apos;t fill yours, it&apos;s
            cancelled. This proof refunds your full stake into a fresh note so nothing ever gets stuck.
          </P>
          <P>
            <strong>Partial credit.</strong> For limit orders that only fill part-way, this returns the unfilled
            remainder. You keep the shares you actually bought and get the rest of your money back.
          </P>

          <H3>When a market is voided</H3>
          <P>
            <strong>Cancel credit.</strong> Occasionally a market resolves to &quot;no outcome&quot; — the question
            became void or meaningless. Once the Vault confirms on-chain that the market truly paid out nothing
            to anyone, this proof refunds your bet in full.
          </P>

          <H3>Selling early &amp; tidying up</H3>
          <P>
            <strong>Position close.</strong> You don&apos;t have to wait for a market to resolve. If you sell your
            shares back before settlement, this credits the sale proceeds into a new note.
          </P>
          <P>
            <strong>Consolidate.</strong> Over time you collect several small notes — change from bets, credits
            from wins. This merges up to four of your notes into one larger note. Pure housekeeping: no money
            moves and no bet is placed.
          </P>

          <Callout title="A note on the technology" tone="info">
            The live circuits are written in <strong>Circom</strong> and compiled to WebAssembly so they can run
            in your browser. (The repo also contains Noir <Code>.nr</Code> files — those are a human-readable
            specification for reference only; they are never compiled or used to make a proof.)
          </Callout>
        </>
      ),
    },
    {
      title: 'Off-chain services',
      body: (
        <>
          <Lead>Two off-chain services keep the experience smooth without ever holding a secret or being able to
            de-anonymize you.</Lead>
          <H3>Signing layer</H3>
          <P>A Node.js service holding the vault EOA key. Per bet it:</P>
          <Steps items={[
            <>Listens for <Code>BetAuthorized</Code> events (windowed, cursor-persisted log scan) and resolves the
              real Polymarket tokenId / conditionId from a market registry.</>,
            <>Funds the Polymarket deposit wallet <strong>just-in-time</strong> right before the order — no
              collateral sits pre-deployed.</>,
            <>Submits to the live CLOB: fill-or-kill for market orders, GTC/GTD for resting limit orders.</>,
            <>Tracks fills over a websocket and signs <strong>one</strong> EIP-712 attestation per bet
              (FILLED / FAILED / PARTIAL / SOLD), which you submit with your credit proof.</>,
            <>Detects market resolution and calls <Code>resolveMarket</Code>, then best-effort redeems collateral.</>,
          ]} />
          <Callout title="Dead-man circuit breaker" tone="warn">
            If Polymarket bans the account (403 / flagged), the signing layer halts all signing and alerts —
            funds stay safe and recoverable through the on-chain cancellation paths.
          </Callout>
          <H3>Proof relay &amp; backend index</H3>
          <P>A stateless service with two jobs:</P>
          <Bullets items={[
            <><strong>Relay</strong> — accepts a proof + public inputs and submits the matching Vault call from its
              own EOA, paying gas. Your wallet only ever signs <Code>Vault.deposit()</Code>. It can&apos;t forge proofs.</>,
            <><strong>Index/cache</strong> — mirrors public on-chain state into SQLite so clients never re-scan the
              chain: <Code>/merkle-path</Code> (O(32) path lookup), <Code>/recovery-data</Code> (your deposits +
              anonymous spend events), <Code>/events</Code> (the public explorer).</>,
          ]} />
          <Callout title="Privacy invariant" tone="gold">
            The index stores only public, anonymous data. It can&apos;t link a spend to a wallet (no secret
            server-side) and can&apos;t forge notes (your client matches events by your own derived nullifier). Worst
            case for a malicious index is <em>incomplete recovery</em> — never theft or de-anonymization.
          </Callout>
        </>
      ),
    },
  ],

  'Security': [
    {
      title: 'Threat model',
      body: (
        <>
          <Lead>
            The adversary PolyShield is built against: a network observer with full on-chain visibility trying
            to link a depositor address to a specific Polymarket bet.
          </Lead>
          <H3>Mitigated</H3>
          <Bullets items={[
            <><strong>Identifying who placed an order</strong> — every order comes from the vault&apos;s single shared EOA.</>,
            <><strong>Linking a nullifier to a depositor</strong> — <Code>N = Poseidon2(secret, nonce)</Code> is not
              derivable without the secret, and excludes balance and owner.</>,
            <><strong>The relay or signing layer learning who bet</strong> — they only see proofs and public inputs.</>,
            <><strong>Forged deposit balance, double-spend, fee under-payment, forged attestation, inflated credit,
              redirected withdrawal</strong> — all blocked on-chain, regardless of who sends the transaction.</>,
            <><strong>A malicious backend index</strong> — serves only public data; worst case is incomplete
              recovery, never theft or de-anonymization.</>,
          ]} />
          <H3>Not mitigated (by design)</H3>
          <Bullets items={[
            <>That a wallet <em>used</em> PolyShield — the deposit is public.</>,
            <>The deposit <em>amount</em> — an ERC-20 transfer amount is on-chain.</>,
            <>Calling a spend function from your <strong>own</strong> wallet — that self-de-anonymizes. The frontend
              never does this; it&apos;s a client discipline.</>,
          ]} />
        </>
      ),
    },
    {
      title: 'Trust assumptions',
      body: (
        <>
          <Lead>
            A plain, honest accounting of what you rely on when you use PolyShield. The headline up front:{' '}
            <strong>nothing here lets anyone take your funds or send them anywhere but your own wallet.</strong>
          </Lead>
          <H3>Upgradeable contracts</H3>
          <P>
            Like nearly every serious DeFi protocol, PolyShield&apos;s contracts are <strong>upgradeable</strong>.
            That&apos;s a feature, not a flaw: it lets the team fix bugs and ship improvements without asking everyone
            to migrate their funds to a new contract. Upgrades are controlled by an owner key.
          </P>
          <P>
            In production that key is a <strong>multisig</strong> — several independent signers who must agree
            before anything changes — so no single person can act alone. You&apos;re trusting that this key is
            responsibly managed, which is the same, well-understood assumption you already make with virtually
            every upgradeable app in crypto. It doesn&apos;t touch your day-to-day privacy, and it doesn&apos;t change the
            withdraw-to-self rule that keeps your money pointed at your own wallet.
          </P>
          <H3>The signing layer (convenience, not custody)</H3>
          <P>
            The operator places your orders on Polymarket. At worst it could be slow or temporarily unavailable —
            an inconvenience, not a way to lose money. It <strong>cannot</strong> move your funds (withdraw-to-self
            is enforced by cryptography) and <strong>cannot</strong> de-anonymize you. If it ever went offline,
            built-in on-chain cancellation paths let you reclaim any in-flight funds yourself. Version 2 runs it
            inside a secure enclave (AWS Nitro) that can cryptographically prove it&apos;s running the honest code.
          </P>
          <H3>Standard cryptography</H3>
          <P>
            PolyShield is built on Groth16, BN254, and Poseidon — the same battle-tested, widely-audited
            primitives used across the ZK ecosystem. You&apos;re trusting math that thousands of engineers and
            billions of dollars already rely on.
          </P>
          <Callout title="What you never have to trust" tone="gold">
            That any server keeps your secret safe — because no server ever receives it. Self-custody is
            absolute: control of your depositing wallet is all you need to control your money, always.
          </Callout>
        </>
      ),
    },
    {
      title: 'Backup & recovery',
      body: (
        <>
          <Lead>There is nothing to back up. Your wallet is your backup — secrets are derived from it on demand.</Lead>
          <H3>How recovery works</H3>
          <Steps items={[
            <>On a new device (or after clearing storage), click <strong>Recover notes</strong>.</>,
            <>The app fetches your public events from the backend index (<Code>/recovery-data</Code>) — no chain scan.</>,
            <>It re-derives your secrets by index from a single wallet signature and keeps only the events whose
              nullifier matches your own.</>,
            <>Your full note set is rebuilt, including credit notes from settlements.</>,
          ]} />
          <Callout title="V2 master seed" tone="info">
            New deposits use a one-signature scheme: a single master-seed signature unlocks every note secret for
            the session, held in memory only. Recovery and every spend in a session collapse to that one
            signature — no per-note prompts.
          </Callout>
          <H3>What you must preserve</H3>
          <P>
            Your wallet, and only your wallet. As long as you control the depositing address, your position is
            recoverable. Lose the wallet and the position is unrecoverable — there is no admin override, by
            design.
          </P>
          <H3>Withdrawal restriction</H3>
          <P>
            You can only withdraw to the wallet that made the original deposit. This is enforced inside the
            withdrawal circuit via the <Code>owner_address</Code> field and independently re-checked by the
            Vault. There is no path to send funds anywhere else.
          </P>
        </>
      ),
    },
    {
      title: 'Fees',
      body: (
        <>
          <Lead>
            All fee rates live in one governance-mutable Vault config and accrue in the pool, claimable by the
            fee recipient. Three fees, current defaults shown.
          </Lead>
          <Term rows={[
            ['Bet fee', <><Code>bet_amount × betFeeBps / 10000 + relayGasFeeUSDC</Code>. Default <strong>0.3%</strong> + <strong>$0.15</strong> relay.</>],
            ['Withdrawal fee', <>flat USDC skim from the payout. Default <strong>$1.00</strong>.</>],
            ['Minimums', <><strong>$1</strong> minimum bet, <strong>$5</strong> minimum withdrawal.</>],
          ]} />
          <H3>Why the bet fee lives inside the circuit</H3>
          <P>
            The Vault can&apos;t see your hidden note balance, so it can&apos;t skim a fee from it directly. Instead it{' '}
            <strong>injects the fee as a public input</strong> to the <Code>BET_AUTH</Code> proof, which enforces{' '}
            <Code>new_balance = balance − bet_amount − fee</Code>. Because the Vault — not you — supplies the fee,
            a proof built with any other fee produces a new commitment that fails verification.
          </P>
          <P>
            The gas reimbursement is always charged in USDC from the note, never as a native POL transfer — a POL
            transfer from your wallet would re-link wallet to bet and defeat the whole point.
          </P>
          <H3>Why the withdrawal fee does not</H3>
          <P>
            A withdrawal pays out USDC the Vault controls directly, so its fee is a plain contract-level skim —
            no circuit involved. The note burns the full amount; you receive the amount minus the fee; the
            difference stays in the pool.
          </P>
        </>
      ),
    },
  ],
  'Reference': [
    {
      title: 'Glossary',
      body: (
        <>
          <Lead>
            Plain-language definitions of the cryptographic and protocol terms used throughout PolyShield. If a
            concept here is unfamiliar, the linked section goes deeper.
          </Lead>

          <H3>Core privacy concepts</H3>
          <Term rows={[
            ['Anonymity set', <>The group of depositors whose bets are indistinguishable on-chain. Because every bet is placed by the vault&apos;s one shared account, an observer cannot tell which member of the set authorized any given trade. A larger set means stronger privacy.</>],
            ['Note', <>Your private balance inside the vault, structured as <Code>(secret, balance, nonce, owner_address)</Code>. Spending a note destroys it and creates a fresh one — only you can prove you own it.</>],
            ['Secret', <>A random value known only to you that controls a note. In current versions it is derived deterministically from a wallet signature, so your wallet alone can regenerate every note. It never leaves your device.</>],
            ['Commitment', <>The public, on-chain fingerprint of a note: <Code>Poseidon4(secret, balance, nonce, owner_address)</Code>. It reveals nothing about the contents but lets you later prove ownership.</>],
            ['Nullifier', <>A one-time tag, <Code>Poseidon2(secret, nonce)</Code>, published when a note is spent to prevent double-spending. It cannot be linked back to a depositor without the secret.</>],
            ['Owner address', <>The depositing wallet, baked into the note commitment. It cryptographically pins withdrawals to your own address (see <em>withdraw-to-self</em>).</>],
            ['Withdraw-to-self', <>The rule that funds can only return to the wallet that deposited them — enforced inside the withdrawal circuit and re-checked on-chain. It is what makes PolyShield <strong>not</strong> a mixer.</>],
          ]} />

          <H3>Zero-knowledge cryptography</H3>
          <Term rows={[
            ['Zero-knowledge proof', <>A proof that a statement is true (&ldquo;I own a note worth X&rdquo;) without revealing the underlying data. PolyShield generates these in your browser for every bet, settlement, and withdrawal.</>],
            ['Circuit', <>The program that defines what a given proof must satisfy. PolyShield ships a circuit per action — deposit, bet, settle, withdraw, and more.</>],
            ['Public input', <>A value visible to the verifier and the chain (e.g. a Merkle root or a nullifier). The vault often injects sensitive public inputs such as the fee or payout so a user cannot forge them.</>],
            ['Groth16', <>The succinct proving system PolyShield uses (over the BN254 curve). Proofs are tiny and cheap to verify on-chain.</>],
            ['Poseidon hash', <>A hash function designed to be efficient inside ZK circuits. PolyShield uses it for all commitments and nullifiers instead of Keccak.</>],
            ['Merkle tree', <>An append-only tree (depth 32) holding every note commitment. Membership in it is what a spend proof demonstrates. See <em>Core concepts → The Merkle tree &amp; nullifiers</em>.</>],
            ['Merkle root', <>The single hash summarizing the whole tree at a point in time. The vault accepts proofs against any root in a rolling recent-history window so concurrent users don&apos;t collide.</>],
          ]} />

          <H3>Protocol &amp; Polymarket</H3>
          <Term rows={[
            ['Vault', <>The smart contract that holds pooled USDC, verifies every proof, and owns the single shared Polymarket account.</>],
            ['Shared EOA', <>The one externally-owned account the vault uses to place all orders on Polymarket. Every depositor&apos;s bets originate here, which is the source of on-chain indistinguishability.</>],
            ['Proof relay', <>The service that submits users&apos; proofs to the vault and pays the gas — so a bet never originates from your wallet. It sees only proofs, never secrets.</>],
            ['Signing layer', <>The operator service that reads authorized-bet events and places the corresponding order on Polymarket from the shared EOA.</>],
            ['Deposit binding', <>A mandatory proof at deposit time that ties your committed balance to the exact USDC amount transferred and to your address, so no one can mint an over-funded note.</>],
            ['CLOB', <>Polymarket&apos;s central limit order book, where orders are matched. PolyShield places fill-and-kill or resting limit orders into it from the shared EOA.</>],
            ['CTF', <>The Gnosis Conditional Tokens Framework — the on-chain contracts that represent market outcomes and pay out when a market resolves. The vault reads payouts directly from it.</>],
            ['Condition ID', <>The CTF identifier for a specific market outcome set, used to look up the official payout at settlement.</>],
            ['Settlement', <>Crediting your note after a market resolves. The vault derives the payout on-chain from the CTF and injects it, so the credit cannot be inflated.</>],
            ['USDC', <>The only collateral PolyShield accepts and pays out. All Polymarket-internal collateral conversion is handled by the vault.</>],
          ]} />
        </>
      ),
    },
  ],
}

const slugify = (s: string) =>
  s.toLowerCase().replace(/&/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

export type DocNavPage = { slug: string; title: string }
export type DocSection = { title: string; pages: DocNavPage[] }
export type DocPage = { slug: string; section: string; title: string; body: ReactNode }

/** Section/page tree for the sidebar — plain serializable data, safe to pass to the
    client DocsShell as a prop. */
export const DOC_SECTIONS: DocSection[] = Object.entries(SECTIONS).map(([title, pages]) => ({
  title,
  pages: pages.map((p) => ({ slug: slugify(p.title), title: p.title })),
}))

/** Flat list of every doc page with its full body — drives routing + static params. */
export const DOC_PAGES: DocPage[] = Object.entries(SECTIONS).flatMap(([section, pages]) =>
  pages.map((p) => ({ slug: slugify(p.title), section, title: p.title, body: p.body })),
)

export function getDocPage(slug: string): DocPage | undefined {
  return DOC_PAGES.find((p) => p.slug === slug)
}
