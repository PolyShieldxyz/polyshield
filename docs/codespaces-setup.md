# GitHub Codespaces Setup Guide — Polyshield

**Goal:** Run the full Polyshield dev stack (Anvil + 5 backend services + optional frontend)
inside a GitHub Codespace instead of your local 8GB machine. Your laptop runs only
a browser tab. Free tier = 60 core-hours/month on a 2-core/4GB machine, or
32 core-hours/month on a 4-core/8GB machine. Use the **4-core/8GB** option — the stack
needs it.

---

## Part 1 — One-Time Setup (do this once, ~20 minutes)

### 1.1 Push your repo to GitHub

You need the repo on GitHub to use Codespaces. If it's already there, skip to 1.2.

```bash
# On your Mac, from the PolyShield repo root:
git remote add origin git@github.com:YOUR_USERNAME/polyshield.git
git push -u origin main
```

Keep the repo **private**. Codespaces on private repos works on all GitHub plans.

---

### 1.2 Create a `.devcontainer/devcontainer.json` file

This tells Codespaces exactly what to install when the container boots. Create this file
in your repo:

**File: `.devcontainer/devcontainer.json`**

```json
{
  "name": "Polyshield Dev",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu-22.04",

  "features": {
    "ghcr.io/devcontainers/features/node:1": { "version": "20" },
    "ghcr.io/devcontainers/features/common-utils:2": {}
  },

  "postCreateCommand": "bash .devcontainer/setup.sh",

  "forwardPorts": [3000, 3001, 3002, 3003, 8545],
  "portsAttributes": {
    "3000": { "label": "Frontend",    "onAutoForward": "notify" },
    "3001": { "label": "Mock CLOB",   "onAutoForward": "silent" },
    "3002": { "label": "Proof Relay", "onAutoForward": "silent" },
    "3003": { "label": "Indexer",     "onAutoForward": "silent" },
    "8545": { "label": "Anvil RPC",   "onAutoForward": "silent" }
  },

  "customizations": {
    "vscode": {
      "extensions": [
        "esbenp.prettier-vscode",
        "dbaeumer.vscode-eslint",
        "NomicFoundation.hardhat-solidity",
        "tamasfe.even-better-toml"
      ],
      "settings": {
        "editor.formatOnSave": true,
        "terminal.integrated.defaultProfile.linux": "bash"
      }
    }
  },

  "remoteEnv": {
    "FOUNDRY_DIR": "/home/vscode/.foundry"
  }
}
```

**File: `.devcontainer/setup.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "==> [setup] Installing Foundry..."
curl -L https://foundry.paradigm.xyz | bash
export PATH="$HOME/.foundry/bin:$PATH"
echo 'export PATH="$HOME/.foundry/bin:$PATH"' >> ~/.bashrc
foundryup

echo "==> [setup] Installing Nargo (Noir)..."
# Install noirup (Noir version manager)
curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash
export PATH="$HOME/.nargo/bin:$PATH"
echo 'export PATH="$HOME/.nargo/bin:$PATH"' >> ~/.bashrc
# Install the Noir version used in this repo
noirup --version 0.37.0

echo "==> [setup] Installing pnpm..."
npm install -g pnpm@9

echo "==> [setup] Installing all workspace dependencies..."
cd /workspaces/polyshield
pnpm install

echo "==> [setup] Pre-building contracts (catches compilation errors early)..."
cd packages/contracts
~/.foundry/bin/forge build
cd /workspaces/polyshield

echo "==> [setup] Done. Run 'pnpm dev:mock' to start the stack."
```

Make the script executable before committing:

```bash
chmod +x .devcontainer/setup.sh
git add .devcontainer/
git commit -m "chore: add devcontainer config for Codespaces"
git push
```

---

### 1.3 Create your Codespace

1. Go to **github.com/YOUR_USERNAME/polyshield**
2. Click the green **Code** button → **Codespaces** tab → **New codespace**
3. Click **Configure and create codespace**
4. Set machine type to **4-core / 8GB RAM** (important — 2-core is not enough)
5. Click **Create codespace**

The container will build. First boot takes 5–8 minutes while it runs `setup.sh`
(Foundry + Nargo + pnpm install + forge build). Every subsequent start of the same
Codespace takes ~30 seconds.

---

### 1.4 Add secrets to Codespaces

Your `.env.example` contains sensitive keys that must not be committed. Store them as
**Codespace secrets** so they are injected as environment variables automatically.

Go to: **github.com/settings/codespaces** → **New secret**

Add these secrets (one by one), and set the repository access to your polyshield repo:

| Secret name | What to put |
|---|---|
| `VAULT_EOA_PRIVATE_KEY` | Any throwaway private key for testnet/dev use |
| `POLY_API_KEY` | `mock-api-key-0000` for dev (real key when going to Amoy) |
| `POLY_SECRET` | `mock-secret-0000` |
| `POLY_PASSPHRASE` | `mock-passphrase-0000` |
| `RELAYER_PRIVATE_KEY` | Another throwaway private key (different from VAULT_EOA) |

For **local dev against Anvil**, mock values work fine. The `pnpm dev:mock` orchestrator
overwrites these with Anvil deterministic keys anyway.

---

## Part 2 — Daily Workflow

### 2.1 Start your Codespace

1. Go to **github.com/YOUR_USERNAME/polyshield → Code → Codespaces**
2. Click your existing Codespace (it will resume, not rebuild)
3. The VS Code editor opens in your browser (or locally if you have the
   GitHub Codespaces VS Code extension)

---

### 2.2 Start the full stack

Open a terminal in VS Code (`Ctrl+\``) and run:

```bash
pnpm dev:mock
```

This starts Anvil, deploys all contracts, and starts all 5 backend services.
Wait for the banner to print (~30 seconds after you see the service labels).

You will see output like:

```
════════════════════════════════════════════════════════════════
  Polyshield — full local dev environment ready
════════════════════════════════════════════════════════════════
  Anvil RPC:          http://127.0.0.1:8545
  Mock CLOB API:      http://127.0.0.1:3001
  Proof relay:        http://127.0.0.1:3002
  Indexer API:        http://127.0.0.1:3003
  Frontend:           http://localhost:3000
  Vault:              0x5FbDB...
```

---

### 2.3 Start the frontend (separate terminal)

Open a second terminal tab (`+` icon in the terminal panel):

```bash
pnpm dev:frontend
```

The frontend starts on port 3000. Codespaces automatically port-forwards it.

**Accessing it in your browser:**

In VS Code, click the **Ports** tab (bottom panel) → find port 3000 → click the
globe icon. This opens the frontend in your local browser with the correct forwarded URL.

---

### 2.4 Connecting MetaMask to Codespace Anvil

Because Anvil runs inside the Codespace, you cannot use `http://127.0.0.1:8545` directly
in MetaMask on your Mac — that address points to your Mac, not the Codespace.

**Option A (recommended): Use the forwarded port URL**

1. In VS Code Ports tab → find port 8545 → right-click → **Copy Local Address**
   You get a URL like `https://CODESPACE-NAME-8545.preview.app.github.com`
2. In MetaMask → Add Network → Custom RPC:
   - RPC URL: the forwarded URL above (with `https://`)
   - Chain ID: `31337`
   - Currency: `ETH`

**Option B: Make the port public temporarily**

In VS Code Ports tab → right-click port 8545 → **Port Visibility → Public**
Then use the public URL in MetaMask. Remember to set it back to private after.

**Importing test wallets into MetaMask:**

The Anvil test private keys are in `packages/backend/.env.test` after `pnpm dev:mock` runs.
Copy `ALICE_PRIVATE_KEY` or `RELAYER_PRIVATE_KEY` and import into MetaMask via
Account → Import Account → Paste Private Key.

---

### 2.5 Running Foundry tests

```bash
cd packages/contracts
forge test
forge test --gas-report
```

Foundry is already in PATH from `setup.sh`. Tests run against a fresh in-process EVM
(no Anvil needed). This is fast even in the Codespace.

---

### 2.6 Running Noir circuit tests

```bash
cd packages/circuits/bet_auth
nargo test

# Or test all circuits at once:
cd packages/circuits
for d in bet_auth bet_cancel cancel_credit settlement_credit withdrawal; do
  echo "=== testing $d ==="
  (cd $d && nargo test)
done
```

---

### 2.7 Stopping the stack

`Ctrl+C` in the `pnpm dev:mock` terminal. All child processes (Anvil + services) are
killed cleanly via the SIGINT handler in `mock-env/src/index.ts`.

---

### 2.8 Stopping the Codespace (saves free hours)

**Important:** A Codespace that is open but idle still consumes core-hours.
Stop it when you're done:

- In the browser: VS Code menu → **Codespaces: Stop Current Codespace**
- Or: go to **github.com/codespaces** → find your Codespace → click `...` → **Stop**

Codespaces also auto-stop after 30 minutes of inactivity by default. You can set this
to a shorter window in **Settings → Codespaces → Default idle timeout**.

---

## Part 3 — Monitoring Your Free Hours

### 3.1 Check usage

Go to: **github.com/settings/billing** → **Codespaces**

The free tier for personal accounts is:
- **120 core-hours/month** (as of 2025 — verify at github.com/pricing)
- On a 4-core machine: that is **30 hours of active running time per month**

### 3.2 Budget your sessions

A typical debug session (boot + dev:mock + frontend + testing) uses:
- Boot time: ~5 minutes (free, counts as running)
- Active testing session: 1–3 hours

At 30 total hours/month you have roughly 10–15 sessions per month before hitting
the free tier. That is enough for active development if you stop the Codespace
between sessions rather than leaving it running.

### 3.3 When you run out

If you exhaust your free hours, billing kicks in at approximately $0.36/hour (4-core).
At that point, switch to Option A (Hetzner CX21 at $6/month fixed) which is cheaper
for sustained use. The switch requires only:
- Renting the VM
- SSH-ing in and cloning the repo
- Setting your `.env` manually
- Running `pnpm dev:mock` the same way you do now

Nothing in the codebase changes.

---

## Part 4 — Troubleshooting

### `forge: command not found`

The setup script adds Foundry to PATH but the current shell may not have sourced `.bashrc`.
Run:
```bash
export PATH="$HOME/.foundry/bin:$PATH"
forge --version
```
If it works, add the export to your terminal's startup or just run it at the start
of each session.

### `nargo: command not found`

Same issue. Run:
```bash
export PATH="$HOME/.nargo/bin:$PATH"
nargo --version
```

### `pnpm dev:mock` fails at deploy step

The most common cause is that `forge build` output changed (a contract was edited).
Run `forge build` manually first to see the error:
```bash
cd packages/contracts && forge build
```

### Port 3000 not accessible in browser

Check the **Ports** tab in VS Code. If port 3000 is not listed, the frontend has not
started yet. Make sure `pnpm dev:frontend` is running in a separate terminal.

If it is listed but shows **Private**, the URL still works from your local browser
as long as you are signed into GitHub in that browser — GitHub handles authentication
for private port forwarding.

### Codespace ran out of disk space

The Codespace image + node_modules + Foundry build artifacts can use 8–12GB.
The default Codespace disk is 32GB so this should not happen, but if it does:
```bash
# Remove Foundry build artifacts
cd packages/contracts && forge clean
# Remove node_modules and reinstall
cd /workspaces/polyshield && rm -rf node_modules && pnpm install
```

### `pnpm install` is slow on first run

This is normal. Subsequent starts of the same Codespace reuse the installed modules
from the persistent disk. Only the first cold boot (or after `rm -rf node_modules`)
takes a long time.

---

## Part 5 — Optional: Use VS Code Desktop Instead of Browser

If you prefer the native VS Code app instead of the browser editor:

1. Install the **GitHub Codespaces** extension in your local VS Code
2. Open VS Code → click the Remote indicator (bottom-left `><` icon) →
   **Connect to Codespace** → select your Codespace

This connects your local VS Code to the Codespace container. All terminals, extensions,
and port forwards work exactly as in the browser version, but with the native app
performance. Especially useful if you find the browser editor sluggish.

---

*Last updated: 2026-05-21*
*Relevant open questions: Q14 (L2 API key derivation), Q15 (CTF Exchange V2 EIP-712 domain)*
*When moving to Polygon Amoy: replace POLYGON_RPC_URL in `.env` with an Alchemy/Infura Amoy endpoint and run `forge script script/Deploy.s.sol --rpc-url $POLYGON_RPC_URL --broadcast`.*
