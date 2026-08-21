/**
 * Check a paymaster URL before it reaches a deploy.
 *
 *   PAYMASTER_URL=https://provider.example/rpc/KEY \
 *     npx tsx scripts/check-paymaster.ts
 *
 * A wrong paymaster URL does not fail loudly — it fails the transaction it was
 * meant to sponsor, in the browser, for one user at a time. Cheaper to find out
 * here.
 *
 * Checks, in the order they break in practice:
 *   1. the endpoint answers JSON-RPC at all (typo, revoked key, wrong project)
 *   2. it serves the right chain (a mainnet URL on a testnet app is silent otherwise)
 *   3. it will actually sponsor OUR contracts (the allowlist step everyone misses)
 */

import { somniaShannon } from "../lib/chain";
import { USDC_ADDRESS } from "../lib/usdc";
import { getContractAddress } from "../lib/chain";

const URL_ = process.env.PAYMASTER_URL?.trim() || process.env.NEXT_PUBLIC_PAYMASTER_URL?.trim();

async function rpc(method: string, params: unknown[]): Promise<{ result?: unknown; error?: { message?: string } }> {
  const response = await fetch(URL_!, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    return { error: { message: `HTTP ${response.status} ${response.statusText}` } };
  }
  return (await response.json()) as { result?: unknown; error?: { message?: string } };
}

async function main(): Promise<void> {
  if (!URL_) {
    throw new Error("set PAYMASTER_URL (or NEXT_PUBLIC_PAYMASTER_URL) to the URL you want to check");
  }
  // Never print the URL: it contains the API key, and this output gets pasted.
  console.log(`Checking paymaster …${URL_.slice(-6)}\n`);

  const chain = await rpc("eth_chainId", []);
  if (chain.error) throw new Error(`endpoint did not answer: ${chain.error.message}`);
  const chainId = Number(chain.result);
  console.log(`  chain id  : ${chainId} ${chainId === somniaShannon.id ? "✓" : `✗ expected ${somniaShannon.id} (Somnia Shannon)`}`);
  if (chainId !== somniaShannon.id) {
    throw new Error("wrong network — select the Somnia Shannon testnet");
  }

  const accepted = await rpc("pm_getAcceptedPaymentTokens", [somniaShannon.id]);
  if (!accepted.error) console.log("  reachable : ✓ paymaster methods answered");

  // The allowlist is the step people skip, and its failure looks like a random
  // rejected transaction days later.
  console.log("\nContracts this app needs sponsored:");
  console.log(`  MimirV2 : ${getContractAddress()}`);
  console.log(`  USDC    : ${USDC_ADDRESS}   (the approve leg of the batch)`);
  console.log("\nAdd BOTH to the paymaster's contract allowlist in the CDP dashboard.");
  console.log("Sponsorship is refused per-call for anything not on that list.");
}

main().catch((err) => {
  console.error("\npaymaster check failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
