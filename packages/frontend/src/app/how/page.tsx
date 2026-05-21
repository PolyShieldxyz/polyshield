import Link from 'next/link'

const STEPS = [
  {
    n: '01',
    title: 'Deposit USDC into the shared vault',
    body: 'You transfer USDC to the Vault contract. A local spending note (secret, balance, nonce) is generated in your browser. The Poseidon commitment of that note becomes a new leaf in the vault\'s Merkle tree. Your deposit amount is public; the note contents are not.',
    code: 'C = poseidon(secret, balance, nonce)',
  },
  {
    n: '02',
    title: 'Choose a Polymarket position',
    body: 'Browse markets and pick a side. Your browser generates a ZK proof (BET_AUTH) proving: (a) your note has sufficient balance, (b) the nullifier belongs to your note, (c) the new note after spending is correctly formed. No secret ever leaves your device.',
    code: 'nullifier = poseidon(secret, nonce)',
  },
  {
    n: '03',
    title: 'Proof relay submits the authorization',
    body: 'Your ZK proof goes to the Proof Relay — not your wallet. The relay submits Vault.authorizeBet() from its own EOA. Your wallet address never appears in any bet-related transaction. Gas is paid by the relay.',
    code: 'Vault.authorizeBet(proof, publicInputs)',
  },
  {
    n: '04',
    title: 'Vault EOA submits the CLOB order',
    body: 'The Signing Layer detects the BetAuthorized event and submits a Fill-Or-Kill order to Polymarket\'s CLOB using the vault\'s single EOA. All traders in the pool share this one address. No CLOB observer can tell which depositor authorized which bet.',
    code: 'POST /order { tokenId, price, size, type: "FOK" }',
  },
  {
    n: '05',
    title: 'Settle winnings as a new private note',
    body: 'When a market resolves, you generate a SETTLE_CRED proof locally. This proof binds your original position to the market outcome without revealing your note\'s identity. The settlement credit becomes a fresh private note in your vault.',
    code: 'new_commitment = poseidon(secret, balance + credit, nonce+1)',
  },
  {
    n: '06',
    title: 'Withdraw to any address',
    body: 'The WITHDRAW proof proves you know a note\'s secret, and commits to a recipient address via its Poseidon hash (a private input). The relay submits the withdrawal. Only the nullifier is public — the link from deposit to withdrawal is cryptographically broken.',
    code: 'recipient_hash = poseidon(recipient_address, 0)',
  },
]

const THREATS = [
  { threat: 'Observer sees which EOA placed the Polymarket order', mitigated: true, how: 'All orders from vault\'s single EOA; depositor never appears' },
  { threat: 'On-chain observer links nullifier to depositor address', mitigated: true, how: 'Nullifier = poseidon(secret, nonce); not derivable without secret' },
  { threat: 'Relay learns which depositor authorized which bet', mitigated: true, how: 'Relay only sees the ZK proof; public inputs contain no depositor ID' },
  { threat: 'Timing correlation between deposit and withdrawal', mitigated: true, how: 'Relay adds random jitter (3–60 min depending on posture)' },
  { threat: 'Deposit amount is private', mitigated: false, how: 'Vault.deposit() is a public ERC-20 transfer; amount is on-chain' },
  { threat: 'That a wallet used Polyshield at all', mitigated: false, how: 'Vault.deposit() is public — only post-deposit activity is private' },
]

export default function HowItWorksPage() {
  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '48px 24px 80px' }}>
      <div className="micro" style={{ color: 'var(--cyan)' }}>HOW IT WORKS</div>
      <h1 className="h2 mt-3" style={{ margin: 0 }}>Private prediction markets, step by step.</h1>
      <p className="body mt-4" style={{ maxWidth: 600 }}>
        Polyshield uses ZK proofs to hide which depositor placed which bet. The vault acts as a single Polymarket account shared by all depositors. Here's the full flow.
      </p>

      <div className="col mt-12 gap-8" style={{ marginTop: 48 }}>
        {STEPS.map(({ n, title, body, code }) => (
          <div key={n} style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: 24 }}>
            <div className="num" style={{ fontSize: 40, color: 'var(--line-strong)', lineHeight: 1, paddingTop: 4 }}>{n}</div>
            <div>
              <h3 style={{ margin: 0, fontSize: 17 }}>{title}</h3>
              <p className="body mt-2" style={{ fontSize: 14 }}>{body}</p>
              <pre className="mono mt-3" style={{ margin: 0, fontSize: 11, color: 'var(--cyan)', background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 6, padding: '10px 14px' }}>{code}</pre>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-16" style={{ marginTop: 64 }}>
        <div className="micro">THREAT MODEL SUMMARY</div>
        <div className="panel mt-4" style={{ padding: 0, marginTop: 16 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Threat</th>
                <th>Mitigated?</th>
                <th>How</th>
              </tr>
            </thead>
            <tbody>
              {THREATS.map(({ threat, mitigated, how }) => (
                <tr key={threat}>
                  <td style={{ fontSize: 13 }}>{threat}</td>
                  <td>
                    <span style={{ fontSize: 11, color: mitigated ? 'var(--green)' : 'var(--red)', fontFamily: 'var(--mono)' }}>
                      {mitigated ? '✓ YES' : '✗ NO'}
                    </span>
                  </td>
                  <td className="small" style={{ fontSize: 12 }}>{how}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="row gap-4 mt-12" style={{ marginTop: 48 }}>
        <Link href="/app/deposit" className="btn btn-primary" style={{ textDecoration: 'none' }}>Start depositing</Link>
        <Link href="/docs" className="btn" style={{ textDecoration: 'none' }}>Read the docs</Link>
      </div>
    </div>
  )
}
