const PHASES = [
  {
    id: 'P1',
    label: 'MVP Alpha · H1 2026',
    title: 'Centralized Signing Layer',
    status: 'IN PROGRESS',
    items: [
      'Noir ZK circuits: BET_AUTH, SETTLE_CRED, WITHDRAWAL, BET_CANCEL, CANCEL_CRED',
      'Vault.sol with Merkle tree, NullifierRegistry, 5 UltraPLONK verifiers',
      'Node.js Signing Layer v1 (centralized operator)',
      'Polymarket Indexer: CTF settlement listener, REST API',
      'Proof Relay: 5 endpoints, relayer EOA pays gas',
      'Next.js frontend: deposit, bet, settle, withdraw flows',
      '$50,000 per-address deposit cap',
      'Polygon Amoy testnet deployment',
      'Bet authorization fee circuit scaffold: betFeeBps and relayGasFeeUSDC wired as Vault-injected public inputs in bet_auth.nr; fee deduction enforced in circuit (new_balance = current_balance - bet_amount - fee). Rates start at zero.',
      'All fee storage slots added to Vault: betFeeBps, relayGasFeeUSDC, autoSettleFeeUSDC, withdrawalFeeUSDC, feeAccumulator, feeRecipient. Owner-controlled, governance-transferable.',
    ],
  },
  {
    id: 'P2',
    label: 'Testnet v1 · H2 2026',
    title: 'End-to-End ZK Proof Flow',
    status: 'PLANNED',
    items: [
      'WASM prover fully wired: real UltraPLONK proofs in the browser (no mock proofs)',
      'Wallet-derived secrets: no note backup needed, full recovery from on-chain history',
      'Operator-driven settlement: users claim winnings with one click, no payout witness required',
      'Auto-settlement opt-in: operator generates settlement proof on user\'s behalf',
      'Auto-settlement fee: 20x estimated Polygon gas cost at settlement, deducted from settlement credit when auto-settle is enabled',
      'Activate bet authorization fee: set betFeeBps and relayGasFeeUSDC to non-zero values via governance after testnet stabilises',
      'Open public beta on Polygon Amoy',
      'End-to-end integration tests across all 5 proof types',
    ],
  },
  {
    id: 'P3',
    label: 'TEE + Multi-chain · H1 2027',
    title: 'TEE Signing Layer + Chain Expansion',
    status: 'PLANNED',
    items: [
      'Signing Layer v2: AWS Nitro Enclave — EOA private key never leaves the enclave boundary',
      'Remote attestation endpoint: users can independently verify the enclave is running unmodified code',
      'Multi-chain deposits: accept USDC from Ethereum mainnet, Base, Arbitrum into the Polygon vault',
      'Cross-chain deposit bridge: lock-and-mint or canonical bridge integration',
      'Multi-EOA rotation: vault EOA ban recovery without disrupting the commitment tree',
      'Withdrawal timing posture: Standard / Fast / Paranoid submission delay buckets',
      'Withdrawal fee: $10 USDC deducted from each withdrawal in Vault.withdraw(), accumulated in feeAccumulator. Discourages micro-withdrawals. Rate is governance-mutable via withdrawalFeeUSDC storage slot.',
    ],
  },
  {
    id: 'P4',
    label: 'Privacy Infrastructure · H2 2027',
    title: 'Advanced Privacy Primitives',
    status: 'PLANNED',
    items: [
      'Privacy metrics dashboard: live anonymity set size, K-anonymity score, timing entropy',
      'SMT-based nullifier registry: O(log n) membership proofs replacing the flat mapping',
      'Decoy traffic system: background cover transactions to reduce timing correlation',
      'Onion-routed proof relay: multi-hop relay network to prevent IP-level correlation',
      'WebSocket live vault feed: real-time BetAuthorized and SettlementCredited events',
      'Sparse Merkle Tree frontend witness generation',
    ],
  },
  {
    id: 'P5',
    label: 'Multi-market · 2028',
    title: 'Prediction Market Expansion',
    status: 'RESEARCH',
    items: [
      'Expand beyond Polymarket: integrate additional prediction market protocols',
      'Abstracted market interface: generic signing layer adapter for any CLOB-based prediction market',
      'Compliant withdrawal mode: selective disclosure ZK proof for regulatory transparency',
      'GTC order support with true partial fill accounting: new proof type and Vault function required (see open-questions.md Q7)',
      'Fee governance transition: transfer fee parameter ownership to an on-chain governance contract',
    ],
  },
  {
    id: 'P6',
    label: 'Post-Quantum · 2028–2029',
    title: 'Post-Quantum ZKP Research',
    status: 'RESEARCH',
    items: [
      'Research lattice-based and hash-based ZK proof systems resistant to quantum adversaries',
      'Evaluate STARKs and other post-quantum-friendly transparent proof systems as long-term replacements',
      'Assess migration path from BN254-based UltraPLONK to a post-quantum backend',
      'Contribute to open ZK standards for quantum-resistant commitment schemes',
    ],
  },
  {
    id: 'P7',
    label: 'ZK Infrastructure · 2028+',
    title: 'Next-Generation Proving',
    status: 'RESEARCH',
    items: [
      'Recursive proofs: aggregate multiple bet authorizations in a single on-chain proof',
      'ZK coprocessor integration: offload proof verification gas to a dedicated coprocessor network',
      'Mobile WASM prover: native-speed proof generation on iOS and Android',
      'Proof marketplace: permissionless GPU operators compete to generate proofs for users',
    ],
  },
]

const STATUS_COLOR: Record<string, string> = {
  'IN PROGRESS': 'var(--amber)',
  PLANNED: 'var(--cyan)',
  RESEARCH: 'var(--violet)',
}

export default function RoadmapPage() {
  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '48px 24px 80px' }}>
      <div className="micro" style={{ color: 'var(--cyan)' }}>ROADMAP</div>
      <h1 className="h2 mt-3" style={{ margin: 0 }}>Building privacy infrastructure for prediction markets.</h1>
      <p className="body mt-4" style={{ maxWidth: 600 }}>
        Seven phases from working prototype to post-quantum-ready ZK privacy network. Each phase is independently useful while enabling the next.
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
