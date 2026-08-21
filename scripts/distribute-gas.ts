/**
 * Top every agent wallet up to a gas target, from the oracle.
 *
 *   npx tsx --env-file-if-exists=.env.local scripts/distribute-gas.ts
 *   DRY_RUN=1 npx tsx ... scripts/distribute-gas.ts     (show the plan, send nothing)
 *
 * Tops UP to a target rather than sending a fixed amount to everyone. Re-running
 * is therefore safe and cheap: a wallet already at its target gets nothing, and a
 * wallet that burned through its gas gets exactly what it is missing.
 *
 * Targets differ by what the role actually spends. A market-creator opening four
 * markets a run burns far more than a philosopher placing the occasional stake,
 * and giving everyone the same number would either starve one or waste on the
 * other.
 */

import { formatEther, parseEther } from "viem";

import { COUNCIL_PERSONAS, personaAddressEnv } from "../agents/council/personas";
import { PHILOSOPHER_PERSONAS } from "../agents/council/philosophers";
import { TRADER_PERSONAS } from "../agents/traders/personas";
import {
  createSomniaPublicClient, createSomniaWalletClientWithKey, getExplorerTxUrl, weiToStt,
} from "../lib/chain";
import { loadAgentWallet } from "../lib/agent-wallets";

/** Keep the funder solvent: it settles markets and pays for evidence. */
const FUNDER_RESERVE_ETH = 0.4;
/** Below this much of the target, a top-up is worth its own gas. */
const TOP_UP_THRESHOLD = 0.7;

const TARGETS = {
  /** Four createClaim calls a run, each one a large calldata write. */
  marketCreator: 0.15,
  /** Stakes plus an x402 purchase per decision. */
  trader: 0.10,
  /** A stake now and then, plus peer reasoning purchases. */
  persona: 0.05,
} as const;

interface Target {
  label: string;
  address: `0x${string}`;
  targetEth: number;
}

function collect(): Target[] {
  const out: Target[] = [];
  const creator = process.env.CREATOR_ADDRESS?.trim();
  if (creator) out.push({ label: "market-creator", address: creator as `0x${string}`, targetEth: TARGETS.marketCreator });

  for (const trader of TRADER_PERSONAS) {
    const address = process.env[trader.addressEnv]?.trim();
    if (address) out.push({ label: trader.displayName, address: address as `0x${string}`, targetEth: TARGETS.trader });
  }
  for (const persona of [...COUNCIL_PERSONAS, ...PHILOSOPHER_PERSONAS]) {
    const address = process.env[personaAddressEnv(persona)]?.trim();
    if (address) out.push({ label: persona.displayName, address: address as `0x${string}`, targetEth: TARGETS.persona });
  }
  return out;
}

async function main(): Promise<void> {
  const dryRun = process.env.DRY_RUN === "1";
  const funder = loadAgentWallet("ORACLE_PRIVATE_KEY");
  const client = createSomniaPublicClient();
  const wallet = createSomniaWalletClientWithKey(process.env.ORACLE_PRIVATE_KEY as `0x${string}`);

  const funderBalance = await client.getBalance({ address: funder.address });
  console.log(`Funder ${funder.address}: ${weiToStt(funderBalance).toFixed(4)} ETH${dryRun ? "  (dry run)" : ""}\n`);

  const targets = collect();
  const balances = await Promise.all(
    targets.map((target) => client.getBalance({ address: target.address })),
  );

  const plan = targets
    .map((target, index) => ({ ...target, current: weiToStt(balances[index]) }))
    .map((target) => ({ ...target, missing: target.targetEth - target.current }))
    // Skip anyone close enough: a top-up worth less than the gas to send it is waste.
    .filter((target) => target.missing > target.targetEth * (1 - TOP_UP_THRESHOLD));

  const total = plan.reduce((sum, target) => sum + target.missing, 0);
  const available = weiToStt(funderBalance) - FUNDER_RESERVE_ETH;

  console.log(`${plan.length} of ${targets.length} wallets below target; ${total.toFixed(4)} ETH needed.`);
  console.log(`Funder can spend ${available.toFixed(4)} ETH and keep ${FUNDER_RESERVE_ETH} in reserve.\n`);

  if (total > available) {
    throw new Error(
      `not enough: need ${total.toFixed(4)} ETH but only ${available.toFixed(4)} is spendable. ` +
      `Lower the targets or fund ${funder.address} first.`,
    );
  }

  for (const target of plan) {
    const amount = target.missing.toFixed(6);
    console.log(`  ${target.label.padEnd(22)} ${target.current.toFixed(4)} → ${target.targetEth}  (+${amount})`);
    if (dryRun) continue;
    const hash = await wallet.sendTransaction({
      account: funder.account, to: target.address, value: parseEther(amount), chain: null,
    });
    await client.waitForTransactionReceipt({ hash });
    console.log(`     ${getExplorerTxUrl(hash)}`);
  }

  if (!dryRun) {
    const left = await client.getBalance({ address: funder.address });
    console.log(`\nDone. Funder now holds ${formatEther(left)} ETH.`);
  }
}

main().catch((err) => {
  console.error("distribute-gas failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
