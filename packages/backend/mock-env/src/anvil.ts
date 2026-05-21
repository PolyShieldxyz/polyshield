/**
 * Anvil process management.
 * Spawns a local Anvil node and waits until it's accepting RPC connections.
 */

import { spawn, ChildProcess, execSync } from "child_process";
import * as http from "http";
import * as os from "os";
import * as path from "path";

const ANVIL_PORT = 8545;
const ANVIL_HOST = "127.0.0.1";

let anvilProcess: ChildProcess | null = null;

function findAnvil(): string {
  // 1. PATH (works if Foundry is in shell profile and shell expanded PATH)
  try { execSync("anvil --version", { stdio: "ignore" }); return "anvil"; } catch (_) {}
  // 2. Foundry's default install location
  const homebrew = path.join(os.homedir(), ".foundry", "bin", "anvil");
  try { execSync(`${homebrew} --version`, { stdio: "ignore" }); return homebrew; } catch (_) {}
  throw new Error("anvil not found. Run: curl -L https://foundry.paradigm.xyz | bash && foundryup");
}

function findForge(): string {
  try { execSync("forge --version", { stdio: "ignore" }); return "forge"; } catch (_) {}
  const homebrew = path.join(os.homedir(), ".foundry", "bin", "forge");
  try { execSync(`${homebrew} --version`, { stdio: "ignore" }); return homebrew; } catch (_) {}
  throw new Error("forge not found. Run: curl -L https://foundry.paradigm.xyz | bash && foundryup");
}

export { findForge };

export function startAnvil(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    console.log("[anvil] starting on port", ANVIL_PORT);
    const anvilBin = findAnvil();

    const proc = spawn(anvilBin, [
      "--port", String(ANVIL_PORT),
      "--chain-id", "31337",
      // No --block-time: instant mining. Each tx is mined immediately.
      // --block-time 1 caused the pipe buffer to fill during execSync, freezing Anvil's HTTP server.
      "--accounts", "10",
      "--balance", "10000",      // 10k ETH each for gas
    ], {
      // inherit: Anvil writes directly to the terminal without going through Node.js pipe buffers.
      // Using "pipe" here caused Anvil to block on write() when execSync held the event loop,
      // which froze its HTTP server and made forge script time out.
      stdio: ["ignore", "inherit", "inherit"],
    });

    proc.on("error", (err) => {
      reject(new Error(`[anvil] failed to start: ${err.message}. Is foundry installed?`));
    });

    proc.on("exit", (code) => {
      if (anvilProcess === proc) {
        console.error(`[anvil] exited unexpectedly with code ${code}`);
        process.exit(1);
      }
    });

    anvilProcess = proc;

    // Poll until the RPC is responsive
    waitForRpc(ANVIL_HOST, ANVIL_PORT, 30_000)
      .then(() => {
        console.log("[anvil] ready");
        resolve(proc);
      })
      .catch((err) => {
        proc.kill();
        reject(err);
      });
  });
}

export function stopAnvil(): void {
  if (anvilProcess) {
    console.log("[anvil] stopping");
    anvilProcess.kill("SIGTERM");
    anvilProcess = null;
  }
}

function waitForRpc(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  function attempt(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (Date.now() > deadline) {
        reject(new Error(`[anvil] RPC not responsive after ${timeoutMs}ms`));
        return;
      }

      const body = JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [],
      });

      const req = http.request(
        { host, port, method: "POST", path: "/", headers: { "Content-Type": "application/json", "Content-Length": body.length } },
        (res) => {
          res.resume();
          res.on("end", () => resolve());
        },
      );
      req.on("error", () => {
        setTimeout(() => attempt().then(resolve).catch(reject), 250);
      });
      req.write(body);
      req.end();
    });
  }

  return attempt();
}
