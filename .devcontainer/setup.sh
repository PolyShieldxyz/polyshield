#!/usr/bin/env bash
set -euo pipefail

echo ""
echo "==> [setup] ── Step 1: Installing Foundry ─────────────────────────────"
curl -L https://foundry.paradigm.xyz | bash
export PATH="$HOME/.foundry/bin:$PATH"
echo 'export PATH="$HOME/.foundry/bin:$PATH"' >> ~/.bashrc
foundryup
forge --version

echo ""
echo "==> [setup] ── Step 2: Installing Nargo (Noir v0.37.0) ────────────────"
curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash
export PATH="$HOME/.nargo/bin:$PATH"
echo 'export PATH="$HOME/.nargo/bin:$PATH"' >> ~/.bashrc
noirup --version 0.37.0
nargo --version

echo ""
echo "==> [setup] ── Step 3: Installing pnpm ────────────────────────────────"
npm install -g pnpm@9
pnpm --version

echo ""
echo "==> [setup] ── Step 4: Installing workspace dependencies ──────────────"
cd /workspaces/polyshield
pnpm install

echo ""
echo "==> [setup] ── Step 5: Pre-building contracts ──────────────────────────"
cd /workspaces/polyshield/packages/contracts
forge build
echo "[setup] contracts built OK"

echo ""
echo "==> [setup] ── Done ────────────────────────────────────────────────────"
echo ""
echo "  To start the full stack:    pnpm dev:mock"
echo "  To start the frontend:      pnpm dev:frontend   (separate terminal)"
echo "  To run contract tests:      cd packages/contracts && forge test"
echo "  To run circuit tests:       cd packages/circuits/bet_auth && nargo test"
echo ""
