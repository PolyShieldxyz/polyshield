// Re-render the snarkjs 0.7.x Groth16 Solidity template for a given verification key, exactly the way
// `snarkjs zkey export solidityverifier` does (ejs.render(template, vk)). Usage: node render.mjs <vk.json>
// Resolves snarkjs/ejs from node_modules in $SNARKJS_PREFIX (default: the security-fv/ dir).
import fs from "fs";
import path from "path";
const prefix = path.resolve(process.env.SNARKJS_PREFIX || path.join(import.meta.dirname, ".."));
const ejs = (await import(path.join(prefix, "node_modules/ejs/lib/ejs.js"))).default;
const template = fs.readFileSync(path.join(prefix, "node_modules/snarkjs/templates/verifier_groth16.sol.ejs"), "utf8");
const vk = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
process.stdout.write(ejs.render(template, vk));
