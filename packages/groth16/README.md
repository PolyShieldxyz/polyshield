# Groth16 Package

Parallel Groth16 proving stack for Polyshield.

This package is intentionally separate from `packages/circuits`, which remains the source of truth for the Noir/UltraPLONK flow.

## Commands

```bash
cd packages/groth16
npm install
npm run compile:circuits
npm run setup:ptau
npm run setup:circuits
npm run generate:verifiers
```

`generate:all` runs the full local developer flow end-to-end.

## Output layout

- `artifacts/<circuit>/` compiled circuit outputs and verification keys
- `setup/` local ptau and zkey files
- `contracts/generated/` Solidity verifiers exported by `snarkjs`
- `contracts/adapters/` `IVerifier`-compatible adapter contracts
