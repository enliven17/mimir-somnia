/**
 * Generate every Mimir agent wallet in one pass:
 *   ORACLE_PRIVATE_KEY, CREATOR_PRIVATE_KEY,
 *   COUNCIL_<SLUG>_PRIVATE_KEY ×10 (classic jury)
 *   COUNCIL_<SLUG>_PRIVATE_KEY ×10 (philosopher jury)
 *
 *   npx tsx scripts/create-agent-wallets.ts           # print the env block
 *   npx tsx scripts/create-agent-wallets.ts --write   # upsert into .env.local
 *
 * The --write mode upserts: existing keys are kept (never rotated silently),
 * only missing ones are generated. It also writes the public address block the
 * WEB server needs (SELLER_ADDRESS + COUNCIL_<SLUG>_ADDRESS ×10) — the web
 * server never sees private keys.
 *
 * Fund the wallets afterwards with scripts/fund-agents.ts.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  listCouncilPersonas,
  personaPrivateKeyEnv,
  personaAddressEnv,
} from "../agents/council/personas";
import {
  PHILOSOPHER_PERSONAS,
  philosopherAddressEnv,
  philosopherPrivateKeyEnv,
} from "../agents/council/philosophers";

const ENV_PATH = ".env.local";
const WRITE = process.argv.includes("--write");

interface WalletEntry {
  keyEnv: string;
  addressEnv?: string;
  label: string;
  privateKey: `0x${string}`;
  address: `0x${string}`;
}

function readExisting(path: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(path)) return map;
  for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) map.set(m[1], m[2].trim());
  }
  return map;
}

function main(): void {
  const existing = readExisting(ENV_PATH);
  const entries: WalletEntry[] = [];

  const make = (keyEnv: string, label: string, addressEnv?: string): WalletEntry => {
    const kept = existing.get(keyEnv);
    const key = (kept && /^0x[0-9a-fA-F]{64}$/.test(kept)
      ? kept
      : generatePrivateKey()) as `0x${string}`;
    const address = privateKeyToAccount(key).address;
    entries.push({ keyEnv, addressEnv, label, privateKey: key, address });
    return entries[entries.length - 1];
  };

  const oracle = make("ORACLE_PRIVATE_KEY", "oracle");
  make("CREATOR_PRIVATE_KEY", "market-creator");
  for (const persona of listCouncilPersonas()) {
    make(personaPrivateKeyEnv(persona), `council:${persona.slug}`, personaAddressEnv(persona));
  }
  // The philosopher jury gets its own wallets, so a philosopher's budget and its
  // record are separable from a classic persona's rather than pooled.
  for (const persona of PHILOSOPHER_PERSONAS) {
    make(
      philosopherPrivateKeyEnv(persona.slug),
      `philosopher:${persona.slug}`,
      philosopherAddressEnv(persona.slug),
    );
  }

  // Address block for the web server: default payment recipient = oracle.
  const addressLines = [
    `SELLER_ADDRESS=${oracle.address}`,
    ...entries
      .filter((e) => e.addressEnv)
      .map((e) => `${e.addressEnv}=${e.address}`),
  ];

  console.log("\n# ── Worker wallets (agents only — NEVER expose to the web server) ──");
  for (const e of entries) {
    console.log(`${e.keyEnv}=${e.privateKey}   # ${e.label} → ${e.address}`);
  }
  console.log("\n# ── Web server addresses (public, safe for Vercel env) ──");
  for (const line of addressLines) console.log(line);

  if (!WRITE) {
    console.log("\n(dry run — re-run with --write to upsert these into .env.local)");
    return;
  }

  // Upsert into .env.local: replace existing keys in place, append the rest.
  let text = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf-8") : "";
  const upsert = (name: string, value: string) => {
    const re = new RegExp(`^${name}=.*$`, "m");
    if (re.test(text)) text = text.replace(re, `${name}=${value}`);
    else text += `${text.endsWith("\n") || text.length === 0 ? "" : "\n"}${name}=${value}\n`;
  };
  for (const e of entries) upsert(e.keyEnv, e.privateKey);
  for (const line of addressLines) {
    const eq = line.indexOf("=");
    upsert(line.slice(0, eq), line.slice(eq + 1));
  }
  writeFileSync(ENV_PATH, text, "utf-8");
  console.log(`\n✓ ${ENV_PATH} updated (${entries.length} wallets, ${addressLines.length} addresses)`);
  console.log("Next: fund the wallets — FUNDER_PRIVATE_KEY=0x... npx tsx scripts/fund-agents.ts");
}

main();
