// Vault contract ABI — only the functions and events the frontend needs.
// Extracted from packages/contracts/out/Vault.sol/Vault.json

export const VAULT_ABI = [
  // ── Read ────────────────────────────────────────────────────────────────────
  {
    type: 'function', name: 'cumulativeDeposits',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function', name: 'tree',
    inputs: [], outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },

  // ── Write ───────────────────────────────────────────────────────────────────
  {
    type: 'function', name: 'deposit',
    inputs: [
      { name: 'commitment', type: 'bytes32' },
      { name: 'amount',     type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function', name: 'authorizeBet',
    inputs: [
      { name: 'proof', type: 'bytes' },
      {
        name: 'inputs', type: 'tuple',
        components: [
          { name: 'merkle_root',    type: 'bytes32' },
          { name: 'nullifier',      type: 'bytes32' },
          { name: 'new_commitment', type: 'bytes32' },
          { name: 'bet_amount',     type: 'uint64'  },
          { name: 'price',          type: 'uint64'  },
          { name: 'expected_shares',type: 'uint64'  },
          { name: 'market_id',      type: 'bytes32' },
          { name: 'outcome_side',   type: 'uint8'   },
          { name: 'position_id',    type: 'bytes32' },
        ],
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function', name: 'creditSettlement',
    inputs: [
      { name: 'proof', type: 'bytes' },
      {
        name: 'inputs', type: 'tuple',
        components: [
          { name: 'merkle_root',       type: 'bytes32' },
          { name: 'nullifier',         type: 'bytes32' },
          { name: 'new_commitment',    type: 'bytes32' },
          { name: 'nullifier_of_bet',  type: 'bytes32' },
          { name: 'market_id',         type: 'bytes32' },
          { name: 'payout_per_share',  type: 'uint64'  },
          { name: 'total_credit',      type: 'uint64'  },
        ],
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function', name: 'withdraw',
    inputs: [
      { name: 'proof', type: 'bytes' },
      {
        name: 'inputs', type: 'tuple',
        components: [
          { name: 'merkle_root',       type: 'bytes32' },
          { name: 'nullifier',         type: 'bytes32' },
          { name: 'withdrawal_amount', type: 'uint64'  },
          { name: 'recipient_hash',    type: 'bytes32' },
        ],
      },
      { name: 'recipientAddress', type: 'address' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function', name: 'betCancellationCredit',
    inputs: [
      { name: 'proof', type: 'bytes' },
      {
        name: 'inputs', type: 'tuple',
        components: [
          { name: 'merkle_root',      type: 'bytes32' },
          { name: 'nullifier',        type: 'bytes32' },
          { name: 'new_commitment',   type: 'bytes32' },
          { name: 'nullifier_of_bet', type: 'bytes32' },
        ],
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },

  // ── Events ──────────────────────────────────────────────────────────────────
  {
    type: 'event', name: 'Deposited',
    inputs: [
      { name: 'depositor',  type: 'address', indexed: true  },
      { name: 'commitment', type: 'bytes32', indexed: false },
      { name: 'amount',     type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event', name: 'BetAuthorized',
    inputs: [
      { name: 'nullifier',       type: 'bytes32', indexed: true  },
      { name: 'market_id',       type: 'bytes32', indexed: false },
      { name: 'position_id',     type: 'bytes32', indexed: false },
      { name: 'expected_shares', type: 'uint64',  indexed: false },
      { name: 'bet_amount',      type: 'uint256', indexed: false },
      { name: 'price',           type: 'uint64',  indexed: false },
      { name: 'new_commitment',  type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event', name: 'Withdrawn',
    inputs: [
      { name: 'nullifier', type: 'bytes32', indexed: true  },
      { name: 'recipient', type: 'address', indexed: false },
      { name: 'amount',    type: 'uint256', indexed: false },
    ],
  },
] as const

export const USDC_ABI = [
  {
    type: 'function', name: 'approve',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function', name: 'allowance',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function', name: 'balanceOf',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function', name: 'decimals',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
  },
  // MockUSDC only — not on mainnet
  {
    type: 'function', name: 'mint',
    inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const
