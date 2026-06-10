type PhaseItem = string

interface PhaseSection {
  sectionTitle: string
  items: PhaseItem[]
}

interface Phase {
  id: string
  label: string
  title: string
  status: 'SHIPPED' | 'IN PROGRESS' | 'PLANNED' | 'RESEARCH'
  items?: PhaseItem[]
  sections?: PhaseSection[]
}

const PHASES: Phase[] = [
  {
    id: 'P1',
    label: 'Core Protocol · shipped',
    title: 'Private Vault — Live on Polygon Mainnet',
    status: 'SHIPPED',
    items: [
      '9 Circom circuits compiled to WASM + Groth16 proving keys: DEPOSIT, BET_AUTH, SETTLEMENT_CREDIT, WITHDRAWAL, BET_CANCEL, CANCEL_CREDIT, POSITION_CLOSE, PARTIAL_CREDIT, CONSOLIDATE',
      'UUPS-upgradeable Vault + CommitmentMerkleTree (Poseidon, depth 32, rolling 1024-root window) + NullifierRegistry + 9 Groth16 verifier adapters, all behind ERC-1967 proxies',
      'Mandatory deposit-binding proof (FC-2): the committed balance is cryptographically tied to the amount actually transferred — no over-commitment',
      'Wallet-derived secrets — secrets derived deterministically from an EIP-191 signature, so users never back anything up; full note recovery from chain history',
      'Operator-driven one-click settlement with payouts derived on-chain from the real Gnosis CTF; client-side WASM proving (real Groth16, no mocks)',
      '$50,000 USDC per-address cumulative deposit cap, enforced in Vault.deposit()',
      'Full deposit → bet → settle → withdraw exercised end-to-end on Polygon mainnet with real funds',
    ],
  },
  {
    id: 'P2',
    label: 'Orders, Fees & Infra · shipped',
    title: 'Order Types, Fees & Backend Index',
    status: 'SHIPPED',
    items: [
      'FAK market orders + GTC/GTD resting limit orders (FC-4), with partial-fill credit for the unfilled remainder',
      'Gasless operator reporting (FC-9): the operator signs a single EIP-712 attestation per bet instead of pushing status on-chain',
      'Just-in-time collateral deployment (FC-7): nothing is pre-deployed; the deposit wallet is funded per-bet, with a reused residual buffer',
      'Protocol fees (FC-10): bet fee + relay-gas reimbursement (injected into BET_AUTH) and a withdrawal fee — all governance-mutable, accruing in the pool',
      'Note consolidation (FC-8) and pre-settlement position close / secondary sale (FC-1)',
      'Backend index/cache + recovery + explorer (FC-12): clients fetch merkle paths, recovery data, and events from the relay — never re-scanning the chain',
      'Live Polymarket integration: real Gamma markets, a conditionId→tokenId market registry, and a settlement resolver (poll + filtered CTF event)',
      'Single-host Docker deployment behind Caddy with automatic TLS',
    ],
  },
  {
    id: 'P3',
    label: 'Hardening & Beta · in progress',
    title: 'Audit, Trust-Minimize the Owner Key, Public Beta',
    status: 'IN PROGRESS',
    items: [
      'Third-party security audit + remediation; enable a tuned Content-Security-Policy',
      'Move the contract owner (instant UUPS upgrade key) to a multisig / HSM and evaluate an upgrade timelock',
      'Base-buffer collateral policy (Option 4 / FC-6) layered over JIT to smooth funding',
      'Persist the signing-layer circuit-breaker halt flag across restarts + a real alert sink (PagerDuty/Telegram)',
      'Grow the anonymity set; define the governance path to lift the per-address deposit cap',
      'Polygon Amoy public testnet cohort and invite-only mainnet beta',
    ],
  },
  {
    id: 'P4',
    label: 'TEE & Trust Minimization · planned',
    title: 'Confidential Signing & Resilience',
    status: 'PLANNED',
    items: [
      'Signing Layer v2: AWS Nitro Enclave — the vault EOA key never leaves the enclave boundary',
      'Remote attestation endpoint + on-chain attestation gate: the Vault accepts bets only from an attested, unmodified signer',
      'Multi-EOA rotation: recover from a Polymarket ban without disrupting the commitment tree',
      'Withdrawal timing posture (Standard / Fast / Paranoid) and an onion-routed relay to resist IP/timing correlation',
      'Fee governance transition: move fee parameters to an on-chain governance contract',
    ],
  },
  {
    id: 'P5',
    label: 'Multi-chain & Scaling · research',
    title: 'Cross-Chain Deposits & Proof Scaling',
    status: 'RESEARCH',
    items: [
      'Multi-chain deposits: accept USDC from Ethereum, Base, and Arbitrum into the Polygon vault via a canonical/lock-and-mint bridge',
      'SMT-based nullifier registry: O(log n) membership proofs replacing the flat mapping',
      'Recursive proofs: aggregate multiple bet authorizations into a single on-chain proof',
      'WebSocket live vault feed; native-speed mobile WASM prover',
      'Expand beyond Polymarket via a generic CLOB adapter; optional compliant selective-disclosure withdrawal mode',
    ],
  },
  {
    id: 'P6',
    label: 'Cryptography Frontier · research',
    title: 'Post-Quantum & FHE',
    status: 'RESEARCH',
    sections: [
      {
        sectionTitle: 'Post-Quantum ZKP Research',
        items: [
          'Research lattice-based and hash-based ZK proof systems resistant to quantum adversaries',
          'Evaluate STARKs and other transparent, post-quantum-friendly proof systems',
          'Assess a migration path from BN254-based Groth16 to a post-quantum ZK backend',
        ],
      },
      {
        sectionTitle: 'Next-Generation Proving',
        items: [
          'ZK coprocessor integration: offload proof verification gas to a dedicated coprocessor network',
          'Proof marketplace: permissionless GPU operators compete to generate proofs for users',
        ],
      },
      {
        sectionTitle: 'Fully Homomorphic Encryption Research',
        items: [
          'Research FHE primitives for private vault state computed without decryption',
          'Evaluate FHE-ZK hybrids — FHE for state confidentiality, ZK for transition validity',
          'Assess FHE-based private order matching as an alternative to the CLOB-proxy architecture',
        ],
      },
    ],
  },
]

const STATUS_COLOR: Record<string, string> = {
  SHIPPED: 'var(--green)',
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
        Six phases from working prototype to cryptography frontier. The core protocol, the full order/fee/recovery stack, and live Polymarket integration are <strong style={{ color: 'var(--green)' }}>shipped and running on Polygon mainnet</strong> — the remaining phases harden, decentralize, and scale it.
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
