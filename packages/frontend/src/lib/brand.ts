// Single source of truth for the deployment status shown across the marketing
// site and app chrome. PolyShield is live on Polygon mainnet in a beta phase —
// real funds, experimental software. Update these in one place so the network
// label can never drift between the nav, footer, and landing page again.
export const NETWORK_LABEL = 'POLYGON MAINNET'
export const PHASE_LABEL = 'BETA'
export const NETWORK_STATUS = `${NETWORK_LABEL} · ${PHASE_LABEL}`

// Canonical public links. Single source of truth so the footer, metadata, and
// any outbound reference can never drift. See memory: official-accounts.
export const SITE_URL = 'https://polyshield.xyz'
export const TWITTER_URL = 'https://x.com/PolyShieldapp'
export const TWITTER_HANDLE = '@PolyShieldapp'
export const GITHUB_URL = 'https://github.com/PolyShieldxyz'
