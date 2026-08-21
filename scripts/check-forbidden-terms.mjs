/**
 * Migration guardrail: fail when the retired chain id or endpoint is added
 * back to source files.
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const FORBIDDEN = [
  ["retired chain id", /\b84532\b/],
];

const files = execSync("git ls-files", { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((file) => /\.(ts|tsx|sol|md|json|toml|js|mjs|css)$/.test(file) || file === ".env.example")
  .filter((file) => file !== "scripts/check-forbidden-terms.mjs")
  .filter((file) => !file.startsWith("package-lock.json"));

const hits = [];
for (const file of files) {
  let lines;
  try { lines = readFileSync(file, "utf8").split(/\r?\n/); } catch { continue; }
  lines.forEach((line, index) => {
    for (const [label, pattern] of FORBIDDEN) {
      if (pattern.test(line)) hits.push({ file, line: index + 1, label, text: line.trim().slice(0, 120) });
    }
  });
}

if (hits.length) {
  console.error(`Found ${hits.length} retired-network reference(s):`);
  for (const hit of hits) console.error(`  ${hit.file}:${hit.line} [${hit.label}] ${hit.text}`);
  process.exit(1);
}

console.log(`No retired-network references found in ${files.length} tracked files.`);
