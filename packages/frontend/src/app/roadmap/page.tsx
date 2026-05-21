const PHASES = [
  {
    id: 'P1',
    label: 'MVP · Q1 2026',
    title: 'Centralized Signing Layer',
    status: 'LIVE',
    items: [
      'Noir ZK circuits: BET_AUTH, SETTLE_CRED, WITHDRAWAL, BET_CANCEL, CANCEL_CRED',
      'Vault.sol with Merkle tree, NullifierRegistry, 5 verifiers',
      'Node.js Signing Layer v1 (centralized operator)',
      'Polymarket Indexer: CTF settlement listener, REST API',
      'Proof Relay: 5 endpoints, relayer EOA pays gas',
      'Next.js frontend: deposit, bet, settle, withdraw flows',
      '$50,000 per-address deposit cap',
      'Polygon Amoy testnet deployment',
    ],
  },
  {
    id: 'P2',
    label: 'Q2–Q3 2026',
    title: 'TEE Signing Layer',
    status: 'PLANNED',
    items: [
      'Signing Layer v2: AWS Nitro Enclave attestation',
      'EOA private key never leaves the enclave boundary',
      'Remote attestation endpoint for users to verify enclave',
      'Decoy traffic system (Q16): background cover transactions',
      'Onion-routed proof relay (Q17): 3-hop TEE relay network',
      'Withdrawal timing posture (Q18): Standard / Fast / Paranoid buckets',
      'Note encryption via wallet public key (ECIES)',
    ],
  },
  {
    id: 'P3',
    label: 'Q3–Q4 2026',
    title: 'Privacy Infrastructure',
    status: 'PLANNED',
    items: [
      'Groth16 verifier contracts (gas reduction: ~376K → ~200K)',
      'Privacy metrics dashboard (Q19): anonymity set, K-anonymity, timing entropy',
      'SMT-based nullifier registry (Q20): O(log n) membership proofs',
      'WebSocket live vault feed (Q21)',
      'Multi-EOA rotation: ban recovery without pool disruption',
      'Sparse Merkle Tree frontend witness generation',
    ],
  },
  {
    id: 'P4',
    label: '2027',
    title: 'Decentralization',
    status: 'RESEARCH',
    items: [
      'Multi-party signing: threshold scheme for EOA key distribution',
      'Decentralized relay network: permissionless relay operators',
      'Protocol fee mechanism (governance TBD)',
      'Cross-chain vault: Ethereum mainnet mirror',
      'Encrypted note backup protocol (Q23)',
      'Compliant withdrawal mode: selective disclosure ZK proof',
    ],
  },
  {
    id: 'P5',
    label: 'Future',
    title: 'ZK Infrastructure',
    status: 'RESEARCH',
    items: [
      'Recursive proofs: aggregate multiple bet auths in one proof',
      'Proof marketplace: users can sell proof generation to GPU operators',
      'ZK coprocessor integration: offload proof verification gas',
      'Mobile WASM prover: native-speed proofs on iOS/Android',
    ],
  },
]

const STATUS_COLOR: Record<string, string> = {
  LIVE: 'var(--green)',
  PLANNED: 'var(--cyan)',
  RESEARCH: 'var(--violet)',
}

export default function RoadmapPage() {
  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '48px 24px 80px' }}>
      <div className="micro" style={{ color: 'var(--cyan)' }}>ROADMAP</div>
      <h1 className="h2 mt-3" style={{ margin: 0 }}>Building privacy infrastructure for prediction markets.</h1>
      <p className="body mt-4" style={{ maxWidth: 600 }}>
        Five phases from centralized prototype to decentralized ZK privacy network. Each phase is independently useful while enabling the next.
      </p>

      <div className="col mt-12 gap-6" style={{ marginTop: 48 }}>
        {PHASES.map(({ id, label, title, status, items }) => (
          <div key={id} style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 32 }}>
            <div style={{ paddingTop: 2 }}>
              <div className="num" style={{ fontSize: 28, color: STATUS_COLOR[status] }}>{id}</div>
              <div className="small mt-1" style={{ fontSize: 11, color: 'var(--text-2)' }}>{label}</div>
              <div className="pill mt-2" style={{ display: 'inline-flex', fontSize: 9, background: 'transparent', border: '1px solid', borderColor: STATUS_COLOR[status], color: STATUS_COLOR[status] }}>{status}</div>
            </div>
            <div className="panel" style={{ padding: 20 }}>
              <div style={{ fontSize: 16, fontWeight: 500, marginBottom: 14 }}>{title}</div>
              <div className="col gap-2">
                {items.map((item) => (
                  <div key={item} className="row gap-3">
                    <span style={{ width: 4, height: 4, borderRadius: '50%', background: STATUS_COLOR[status], flexShrink: 0, marginTop: 7 }} />
                    <span style={{ fontSize: 13 }}>{item}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
