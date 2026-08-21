/**
 * Quick read of every Mimir agent wallet on Somnia Shannon testnet.
 * Shows native ETH (gas) and USDC (stake) balances.
 *
 * Run: npx tsx --env-file-if-exists=.env.local scripts/check-agent-balances.ts
 */
import { privateKeyToAccount } from "viem/accounts";
import { createSomniaPublicClient, weiToStt, getExplorerAddressUrl } from "../lib/chain";
import { listCouncilPersonas, personaPrivateKeyEnv, personaAddressEnv } from "../agents/council/personas";
import {
  PHILOSOPHER_PERSONAS,
  philosopherAddressEnv,
  philosopherPrivateKeyEnv,
} from "../agents/council/philosophers";
import { ERC20_ABI, USDC_ADDRESS, unitsToUsdc } from "../lib/usdc";

function addressFromKeyEnv(keyEnv: string): `0x${string}` | null {
  const key = process.env[keyEnv]?.trim();
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) return null;
  return privateKeyToAccount(key as `0x${string}`).address;
}

async function withRpcRetry<T>(read: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
  throw lastError;
}

async function main(): Promise<void> {
  const client = createSomniaPublicClient();

  const rows: Array<{ label: string; address: `0x${string}` }> = [];
  const oracle = addressFromKeyEnv("ORACLE_PRIVATE_KEY") ?? (process.env.ORACLE_ADDRESS as `0x${string}` | undefined);
  const creator = addressFromKeyEnv("CREATOR_PRIVATE_KEY") ?? (process.env.CREATOR_ADDRESS as `0x${string}` | undefined);
  if (oracle) rows.push({ label: "oracle", address: oracle });
  if (creator) rows.push({ label: "market-creator", address: creator });
  for (const persona of listCouncilPersonas()) {
    const addr =
      addressFromKeyEnv(personaPrivateKeyEnv(persona)) ??
      (process.env[personaAddressEnv(persona)] as `0x${string}` | undefined);
    if (addr) rows.push({ label: `council:${persona.slug}`, address: addr });
  }
  for (const persona of PHILOSOPHER_PERSONAS) {
    const addr =
      addressFromKeyEnv(philosopherPrivateKeyEnv(persona.slug)) ??
      (process.env[philosopherAddressEnv(persona.slug)] as `0x${string}` | undefined);
    if (addr) rows.push({ label: `philosopher:${persona.slug}`, address: addr });
  }

  if (rows.length === 0) {
    console.error("No agent wallets configured — run: npx tsx scripts/create-agent-wallets.ts --write");
    process.exit(1);
  }

  console.log("Somnia Shannon testnet balances (gas ETH + stake USDC):\n");
  console.log(`USDC token: ${USDC_ADDRESS}\n`);
  for (const row of rows) {
    const bot = await withRpcRetry(() => client.getBalance({ address: row.address }));
    const usdc = await withRpcRetry(() => client.readContract({
      address: USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [row.address],
    })) as bigint;
    console.log(
      `  ${row.label.padEnd(26)} ${weiToStt(bot).toFixed(4).padStart(8)} ETH  ${unitsToUsdc(usdc).toFixed(2).padStart(10)} USDC  ${row.address}`
    );
  }
  console.log(`\n${getExplorerAddressUrl(rows[0].address)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
