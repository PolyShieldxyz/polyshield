const ROLES = [
  { title: 'ZK Circuit Engineer', team: 'Research', type: 'Full-time', location: 'Remote', desc: 'Design and implement Noir ZK circuits for bet authorization, settlement, and withdrawal. Requires Noir or Circom experience, deep familiarity with PLONK-family proving systems.' },
  { title: 'Solidity / EVM Engineer', team: 'Contracts', type: 'Full-time', location: 'Remote', desc: 'Own the Vault.sol and supporting contract suite. Experience with Foundry, Polygon, ERC-20 integrations, and security-critical Solidity patterns (reentrancy guards, access control).' },
  { title: 'Cryptography Researcher', team: 'Research', type: 'Full-time / Contract', location: 'Remote', desc: 'Research anonymity set growth, timing entropy, and K-anonymity properties. Formal analysis of Polyshield\'s privacy model against adaptive adversaries.' },
  { title: 'Full-stack Engineer (Next.js / Wagmi)', team: 'Product', type: 'Full-time', location: 'Remote', desc: 'Build the proof generation UX, vault dashboard, and privacy metrics views. Experience with wagmi v2, ethers.js, and client-side WASM prover integration preferred.' },
  { title: 'Node.js Backend Engineer', team: 'Infrastructure', type: 'Full-time', location: 'Remote', desc: 'Build and maintain the Signing Layer (TEE), Proof Relay, and Polymarket Indexer. Experience with ethers.js, secure key management, and rate-limited CLOB API clients.' },
  { title: 'TEE / Systems Engineer', team: 'Infrastructure', type: 'Full-time', location: 'Remote', desc: 'Design and operate the AWS Nitro Enclave-based Signing Layer v2. Experience with confidential computing, remote attestation, and secure enclave lifecycle management.' },
  { title: 'Security Researcher', team: 'Security', type: 'Contract', location: 'Remote', desc: 'Audit ZK circuits for soundness, Solidity contracts for economic attacks, and the privacy model for deanonymization vectors. Deliverable: formal report with severity classifications.' },
]

const CULTURE = [
  ['Privacy first', 'We don\'t collect what we don\'t need. Our own system doesn\'t even know which depositor placed which bet.'],
  ['Zero-knowledge, not zero-trust', 'We trust cryptography over promises. Every privacy claim is backed by a proof, not a policy.'],
  ['Ship incrementally', 'v1 is centralized. We say so clearly. Decentralization is the roadmap, not the marketing copy.'],
  ['Security over velocity', 'We don\'t skip audits. Circuit soundness and contract security gate every deployment.'],
]

export default function CareersPage() {
  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '48px 24px 80px' }}>
      <div className="micro" style={{ color: 'var(--cyan)' }}>CAREERS</div>
      <h1 className="h2 mt-3" style={{ margin: 0 }}>Build private financial infrastructure.</h1>
      <p className="body mt-4" style={{ maxWidth: 600 }}>
        We're a small team building ZK privacy infrastructure for prediction markets. Every role touches cryptography, security, or both. We default to remote and async.
      </p>

      <div className="panel mt-10 mb-8" style={{ padding: 0, marginTop: 40, marginBottom: 32 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Role</th>
              <th>Team</th>
              <th>Type</th>
              <th>Location</th>
            </tr>
          </thead>
          <tbody>
            {ROLES.map(({ title, team, type, location }) => (
              <tr key={title} style={{ cursor: 'pointer' }}>
                <td style={{ fontSize: 13 }}>{title}</td>
                <td><span className="pill pill-soft" style={{ fontSize: 9 }}>{team.toUpperCase()}</span></td>
                <td className="small" style={{ fontSize: 12 }}>{type}</td>
                <td className="small" style={{ fontSize: 12 }}>{location}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="col gap-4" style={{ marginTop: 32 }}>
        {ROLES.map(({ title, desc }) => (
          <div key={title} className="panel" style={{ padding: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 8 }}>{title}</div>
            <div className="body" style={{ fontSize: 13 }}>{desc}</div>
            <div className="mt-3">
              <a href="mailto:jobs@polyshield.xyz" className="btn btn-sm" style={{ textDecoration: 'none', fontSize: 11 }}>Apply → jobs@polyshield.xyz</a>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-12" style={{ marginTop: 48 }}>
        <div className="micro">CULTURE</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
          {CULTURE.map(([title, desc]) => (
            <div key={title} className="panel" style={{ padding: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>{title}</div>
              <div className="body" style={{ fontSize: 12 }}>{desc}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
