/**
 * Generates JSON fixture files from the TypeScript sources.
 * Run: ts-node src/generate.ts
 * Output: fixtures/ directory
 */

import * as fs from "fs";
import * as path from "path";
import { ALL_USERS, VALID_USERS, BOUNDARY_USERS, ADVERSARIAL_USERS } from "./users";
import { ALL_MARKETS, ACTIVE_MARKETS, RESOLVED_MARKETS, ADVERSARIAL_MARKETS } from "./markets";
import { ALL_ACTIONS, ADVERSARIAL_SEQUENCES, summarize } from "./actions";

const OUT = path.join(__dirname, "..", "fixtures");

function write(name: string, data: unknown): void {
  const filePath = path.join(OUT, `${name}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, (_, v) =>
    typeof v === "bigint" ? v.toString() : v, 2));
  const raw = JSON.stringify(data, (_, v) => typeof v === "bigint" ? v.toString() : v);
  console.log(`  wrote ${filePath} (${raw.length} chars)`);
}

function main(): void {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  console.log("Generating fixtures...\n");

  // Users
  console.log("Users:");
  write("users_valid", VALID_USERS);
  write("users_boundary", BOUNDARY_USERS);
  write("users_adversarial", ADVERSARIAL_USERS);
  write("users_all", ALL_USERS);
  console.log(`  total: ${ALL_USERS.length} users\n`);

  // Markets
  console.log("Markets:");
  write("markets_active", ACTIVE_MARKETS);
  write("markets_resolved", RESOLVED_MARKETS);
  write("markets_adversarial", ADVERSARIAL_MARKETS);
  write("markets_all", ALL_MARKETS);
  console.log(`  total: ${ALL_MARKETS.length} markets\n`);

  // Actions
  console.log("Actions:");
  write("actions_all", ALL_ACTIONS);
  write("actions_sequences", ADVERSARIAL_SEQUENCES);
  const stats = summarize(ALL_ACTIONS);
  write("actions_stats", stats);
  console.log(`  total: ${ALL_ACTIONS.length} actions`);
  console.log(`  sequences: ${ADVERSARIAL_SEQUENCES.length}`);
  console.log(`  by attack vector:`);
  for (const [k, v] of Object.entries(stats).sort()) {
    console.log(`    ${k}: ${v}`);
  }
  console.log();

  console.log("Done.");
}

main();
