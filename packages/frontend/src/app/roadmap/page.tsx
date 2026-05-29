type PhaseItem = string

interface PhaseSection {
  sectionTitle: string
  items: PhaseItem[]
}

interface Phase {
  id: string
  label: string
  title: string
  status: 'IN PROGRESS' | 'PLANNED' | 'RESEARCH'
  items?: PhaseItem[]
  sections?: PhaseSection[]
}

const PHASES: Phase[] = [
  {
    id: 'P1',
    label: 'MVP Alpha · H1 2026',
    title: 'Core Protocol',
    status: 'IN PROGRESS',
    items: [
      'Circom ZK circuits compiled to WASM + Groth16 proving keys: BET_AUTH, SETTLE_CRED, WITHDRAWAL, BET_CANCEL, CANCEL_CRED',
      'Vault.sol with Poseidon Merkle tree (depth 32), NullifierRegistry, 5 Groth16 verifiers (snarkjs)',
      'Node.js Signing Layer v1 — centralized operator, FOK-only order submission to Polymarket CLOB',
      'Polymarket Indexer: CTF ConditionResolution listener, payout_per_share computation, REST API',
      'Proof Relay: 5 stateless endpoints (bet, settlement, withdrawal, bet-cancel, na-cancel); relay EOA pays gas',
      'Next.js frontend: deposit, bet, settle, and withdraw flows with client-side WASM prover',
      '$50,000 USDC per-address cumulative deposit cap enforced in Vault.deposit()',
      'Local dev stack: Anvil + MockUSDC + MockCTF + mock CLOB server + all backend services',
      'No fees in P1 — fee infrastructure is a P2 feature',
    ],
  },
  {
    id: 'P2',
    label: 'Private Beta · H2 2026',
    title: 'Full ZK Flow + Fees',
    status: 'PLANNED',
    items: [
      'WASM prover fully wired: real Groth16 proofs in the browser via snarkjs — no mock proofs',
      'Random-secret note generation with mandatory ECIES-encrypted backup to the user\'s wallet public key',
      'Operator-driven settlement: users claim winnings with one click — no payout witness required',
      '"Withdrawal with Change" circuit: withdraw settled balance while active positions remain open',
      'Bet authorization fee: percentage of bet amount, rate TBD — deducted inside BET_AUTH circuit as a Vault-injected public input',
      'Relay gas fee: flat USDC amount bundled with the bet auth fee, rate TBD — not surfaced to users separately',
      'All fee rates stored as governance-mutable Vault storage slots; no circuit redeployment needed to update rates',
      'Fee accumulator and feeRecipient in Vault.sol; owner-controlled initially',
      'Polygon Amoy testnet deployment',
      'Private beta cohort: limited invite-only access, testnet USDC provided — no open public access',
      'End-to-end integration tests across all 5 proof types and the full deposit → bet → settle → withdraw flow',
    ],
  },
  {
    id: 'P3',
    label: 'Multi-chain · H1 2027',
    title: 'Chain Expansion & Wallet Hardening',
    status: 'PLANNED',
    items: [
      'Wallet-derived secrets: secrets derived deterministically from an EIP-191 wallet signature — no note backup ever needed; full note recovery from on-chain history',
      'Multi-chain deposits: accept USDC from Ethereum mainnet, Base, and Arbitrum into the Polygon vault',
      'Cross-chain deposit bridge: lock-and-mint or canonical bridge integration',
      'Multi-EOA rotation: vault EOA ban recovery without disrupting the commitment tree; governance-controlled authorizedSigners mapping in Vault.sol',
      'Withdrawal timing posture: Standard / Fast / Paranoid submission delay buckets at the relay layer',
    ],
  },
  {
    id: 'P4',
    label: 'Advanced Infrastructure · H2 2027',
    title: 'TEE, Governance & Privacy Primitives',
    status: 'RESEARCH',
    items: [
      'Signing Layer v2: AWS Nitro Enclave — EOA private key never leaves the enclave boundary',
      'Remote attestation endpoint: users can independently verify the enclave is running unmodified code',
      'Per-address deposit cap removal: lifted via governance once the anonymity set is large enough to resist concentration attacks',
      'Withdrawal fee: fixed USDC amount per withdrawal, rate TBD — enforced by Vault.withdraw() directly, no circuit change needed',
      'Fee governance transition: transfer fee parameter ownership to an on-chain governance contract',
      'Privacy metrics dashboard: live anonymity set size, K-anonymity score, timing entropy',
      'Decoy traffic system: background cover transactions to reduce timing-correlation attacks',
      'Onion-routed proof relay: multi-hop relay network to prevent IP-level correlation',
      'SMT-based nullifier registry: O(log n) membership proofs replacing the flat mapping',
      'WebSocket live vault feed: real-time BetAuthorized and SettlementCredited event streaming',
      'Expand to other ecosystems: Solana, Cosmos, Polkadot — modular vault architecture with chain-specific adapters',
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
    ],
  },
  {
    id: 'P6',
    label: '2029+',
    title: 'Cryptography Frontier',
    status: 'RESEARCH',
    sections: [
      {
        sectionTitle: 'Post-Quantum ZKP Research',
        items: [
          'Research lattice-based and hash-based ZK proof systems resistant to quantum adversaries',
          'Evaluate STARKs and other post-quantum-friendly transparent proof systems as long-term replacements',
          'Assess migration path from BN254-based Groth16 to a post-quantum ZK backend',
          'Contribute to open ZK standards for quantum-resistant commitment schemes',
        ],
      },
      {
        sectionTitle: 'Next-Generation Proving',
        items: [
          'Recursive proofs: aggregate multiple bet authorizations in a single on-chain proof',
          'ZK coprocessor integration: offload proof verification gas to a dedicated coprocessor network',
          'Mobile WASM prover: native-speed proof generation on iOS and Android',
          'Proof marketplace: permissionless GPU operators compete to generate proofs for users',
        ],
      },
      {
        sectionTitle: 'Fully Homomorphic Encryption Research',
        items: [
          'Research FHE primitives for private smart contract state: vault balances and positions computed without decryption',
          'Evaluate FHE-ZK hybrid architectures — FHE for state confidentiality, ZK for state transition validity',
          'Assess FHE-based private order matching as an alternative to the CLOB-proxy architecture',
          'Contribute to FHE standards and tooling for EVM and non-EVM blockchain applications',
        ],
      },
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
        Six phases from working prototype to cryptography frontier. Each phase is independently useful while enabling the next.
      </p>

      <div className="col mt-12 gap-6" style={{ marginTop: 48 }}>
        {PHASES.map(({ id, label, title, status, items, sections }) => (
          <div key={id} style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 32 }}>
            <div style={{ paddingTop: 2 }}>
              <div className="num" style={{ fontSize: 28, color: STATUS_COLOR[status] }}>{id}</div>
              <div className="small mt-1" style={{ fontSize: 11, color: 'var(--text-2)' }}>{label}</div>
              <div className="pill mt-2" style={{ display: 'inline-flex', fontSize: 9, background: 'transparent', border: '1px solid', borderColor: STATUS_COLOR[status], color: STATUS_COLOR[status] }}>{status}</div>
            </div>
            <div className="panel" style={{ padding: 20 }}>
              <div style={{ fontSize: 16, fontWeight: 500, marginBottom: 14 }}>{title}</div>

              {sections ? (
                <div className="col gap-6">
                  {sections.map(({ sectionTitle, items: sItems }) => (
                    <div key={sectionTitle}>
                      <div className="micro" style={{ fontSize: 10, color: STATUS_COLOR[status], marginBottom: 8 }}>
                        {sectionTitle.toUpperCase()}
                      </div>
                      <div className="col gap-2">
                        {sItems.map((item) => (
                          <div key={item} className="row gap-3">
                            <span style={{ width: 4, height: 4, borderRadius: '50%', background: STATUS_COLOR[status], flexShrink: 0, marginTop: 7 }} />
                            <span style={{ fontSize: 13 }}>{item}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="col gap-2">
                  {(items ?? []).map((item) => (
                    <div key={item} className="row gap-3">
                      <span style={{ width: 4, height: 4, borderRadius: '50%', background: STATUS_COLOR[status], flexShrink: 0, marginTop: 7 }} />
                      <span style={{ fontSize: 13 }}>{item}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
