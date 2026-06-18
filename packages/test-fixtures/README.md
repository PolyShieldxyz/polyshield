# packages/test-fixtures

Generated, deterministic test data for Polyshield — synthetic markets, users, and action sequences
used across contract, backend, and frontend tests. **No real funds, addresses, or Polymarket data.**

```
src/
  markets.ts    Market generators (active / resolved / adversarial)
  users.ts      User generators (valid / boundary / adversarial)
  actions.ts    Action-sequence generators (deposit → bet → settle → withdraw, plus edge cases)
  generate.ts   Writes the JSON fixtures into fixtures/
  index.ts      Programmatic exports
fixtures/       Generated JSON (markets_*.json, users_*.json, actions_*.json) — committed
```

## Usage

```bash
cd packages/test-fixtures
pnpm generate     # regenerate fixtures/ from src/
pnpm test         # jest (passWithNoTests)
```

The generators are deterministic, so regenerating produces the same output unless a generator
changes. Regenerate and commit the `fixtures/` JSON whenever you edit a generator.
