/**
 * One-shot: fund all other agent wallets from ORACLE_PRIVATE_KEY in .env.local.
 * Strips inline comments from env values.
 *
 *   npx tsx --env-file=.env.local scripts/fund-from-oracle.ts
 */
import { formatEther, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  createSomniaPublicClient,
  createSomniaWalletClientWithKey,
  weiToStt,
  getExplorerTxUrl,
  somniaShannon,
} from "../lib/chain";
const weiToEth = weiToStt;
import {
  listCouncilPersonas,
  personaPrivateKeyEnv,
} from "../agents/council/personas";
import { PHILOSOPHER_PERSONAS, philosopherPrivateKeyEnv } from "../agents/council/philosophers";
import { ERC20_ABI, USDC_ADDRESS, formatAtomicUsdc, parseUsdcAtomic } from "../lib/usdc";

function cleanEnv(name: string): string {
  const raw = process.env[name] ?? "";
  return raw.split(/\s+#/)[0].trim();
}

const GAS_ETH = parseEther(process.env.FUND_GAS_ETH ?? "0.01");
const USDC_CREATOR = parseUsdcAtomic(process.env.FUND_AMOUNT_USDC ?? "20");
const USDC_COUNCIL = parseUsdcAtomic(process.env.FUND_COUNCIL_AMOUNT_USDC ?? "10");
const DRY_RUN = process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";

function bigintMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

async function main() {
  const funderKey = cleanEnv("ORACLE_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(funderKey)) {
    throw new Error("ORACLE_PRIVATE_KEY missing or invalid in .env.local");
  }

  // Make sure agent loaders see clean keys
  process.env.ORACLE_PRIVATE_KEY = funderKey;
  for (const name of [
    "CREATOR_PRIVATE_KEY",
    ...listCouncilPersonas().map((p) => personaPrivateKeyEnv(p)),
    ...PHILOSOPHER_PERSONAS.map((p) => philosopherPrivateKeyEnv(p.slug)),
  ]) {
    const c = cleanEnv(name);
    if (c) process.env[name] = c;
  }

  const publicClient = createSomniaPublicClient();
  const funder = privateKeyToAccount(funderKey as `0x${string}`);
  const wallet = createSomniaWalletClientWithKey(funderKey);

  const targets: Array<{ label: string; address: `0x${string}`; gas: bigint; usdc: bigint }> = [];

  const add = (label: string, keyEnv: string, usdc: bigint) => {
    const key = process.env[keyEnv]?.trim() ?? "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
      console.warn(`  · skip ${label} — ${keyEnv} not set`);
      return;
    }
    const address = privateKeyToAccount(key as `0x${string}`).address;
    // Don't send gas/USDC to funder itself
    if (address.toLowerCase() === funder.address.toLowerCase()) {
      console.log(`  · ${label.padEnd(24)} is funder — skip self-transfer`);
      return;
    }
    targets.push({ label, address, gas: GAS_ETH, usdc });
  };

  add("market-creator", "CREATOR_PRIVATE_KEY", USDC_CREATOR);
  for (const persona of listCouncilPersonas()) {
    add(`council:${persona.slug}`, personaPrivateKeyEnv(persona), USDC_COUNCIL);
  }
  for (const persona of PHILOSOPHER_PERSONAS) {
    const cycleBudget = parseUsdcAtomic(String(persona.limits.maxStakeUsdc * persona.limits.maxClaimsPerCycle));
    add(`philosopher:${persona.slug}`, philosopherPrivateKeyEnv(persona.slug), bigintMin(USDC_COUNCIL, cycleBudget));
  }

  const funderEth = await publicClient.getBalance({ address: funder.address });
  const funderUsdc = (await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [funder.address],
  })) as bigint;

  console.log(`Funder (oracle): ${funder.address}`);
  console.log(`  ETH  : ${weiToStt(funderEth).toFixed(4)}`);
  console.log(`  USDC : ${formatAtomicUsdc(funderUsdc)}`);
  console.log(`Targets: ${targets.length}`);
  console.log(`Per target gas: ${formatEther(GAS_ETH)} ETH`);
  console.log(`Creator USDC: ${formatAtomicUsdc(USDC_CREATOR)}`);
  console.log(`Council USDC: ${formatAtomicUsdc(USDC_COUNCIL)}\n`);

  const distributionEth = targets.reduce((total, target) => total + target.gas, 0n);
  const distributionUsdc = targets.reduce((total, target) => total + target.usdc, 0n);
  console.log(`Distribution total: ${formatEther(distributionEth)} ETH + ${formatAtomicUsdc(distributionUsdc)} USDC`);
  if (DRY_RUN) {
    for (const target of targets) {
      console.log(`  ${target.label.padEnd(24)} ${target.address}  ${formatEther(target.gas)} ETH + ${formatAtomicUsdc(target.usdc)} USDC`);
    }
    console.log("\nDry run only; no transfers sent.");
    return;
  }

  for (const t of targets) {
    // Gas
    const ethBal = await publicClient.getBalance({ address: t.address });
    if (ethBal < t.gas) {
      const hash = await wallet.sendTransaction({
        account: funder,
        to: t.address,
        value: t.gas,
        chain: somniaShannon,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      console.log(`  ✓ ${t.label.padEnd(24)} +${formatEther(t.gas)} ETH  ${getExplorerTxUrl(hash)}`);
    } else {
      console.log(`  · ${t.label.padEnd(24)} gas ok (${weiToEth(ethBal).toFixed(4)} ETH)`);
    }

    // USDC
    const usdcBal = (await publicClient.readContract({
      address: USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [t.address],
    })) as bigint;
    if (usdcBal < t.usdc) {
      const need = t.usdc - usdcBal;
      const hash = await wallet.writeContract({
        account: funder,
        address: USDC_ADDRESS,
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [t.address, need],
        chain: somniaShannon,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      console.log(`  ✓ ${t.label.padEnd(24)} +${formatAtomicUsdc(need)} USDC  ${getExplorerTxUrl(hash)}`);
    } else {
      console.log(`  · ${t.label.padEnd(24)} USDC ok (${formatAtomicUsdc(usdcBal)})`);
    }
  }

  console.log("\nDone. Run: npm run agents:balances");
}

main().catch((err) => {
  console.error("fund-from-oracle failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
