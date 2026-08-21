/**
 * Fund the demo BYOA traders from ORACLE_PRIVATE_KEY.
 *
 *   npx tsx --env-file-if-exists=.env.local scripts/fund-traders.ts
 *   TRADER_FUND_ETH=0.004 TRADER_FUND_USDC=6 npx tsx ... scripts/fund-traders.ts
 *
 * Separate from fund-from-oracle.ts, which funds the council personas by their own
 * naming convention. Sends only what a trader needs to place a few stakes: topping
 * up is cheap, and a demo wallet holding a large balance is a needless target.
 */

import { parseEther } from "viem";

import { TRADER_PERSONAS } from "../agents/traders/personas";
import {
  createSomniaPublicClient, createSomniaWalletClientWithKey, getExplorerTxUrl, weiToStt,
} from "../lib/chain";
const weiToEth = weiToStt;
import { loadAgentWallet, transferUsdc } from "../lib/agent-wallets";
import { ERC20_ABI, USDC_ADDRESS, unitsToUsdc } from "../lib/usdc";

const GAS_ETH = process.env.TRADER_FUND_ETH ?? "0.004";
const STAKE_USDC = process.env.TRADER_FUND_USDC ?? "6";

async function main(): Promise<void> {
  const funder = loadAgentWallet("ORACLE_PRIVATE_KEY");
  const client = createSomniaPublicClient();
  const wallet = createSomniaWalletClientWithKey(process.env.ORACLE_PRIVATE_KEY as `0x${string}`);

  const [funderEth, funderUsdc] = await Promise.all([
    client.getBalance({ address: funder.address }),
    client.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [funder.address] }) as Promise<bigint>,
  ]);
  console.log(`Funder ${funder.address}: ${weiToEth(funderEth).toFixed(4)} ETH · ${unitsToUsdc(funderUsdc).toFixed(2)} USDC`);
  console.log(`Sending ${GAS_ETH} ETH + ${STAKE_USDC} USDC to each of ${TRADER_PERSONAS.length} traders\n`);

  for (const persona of TRADER_PERSONAS) {
    const address = process.env[persona.addressEnv]?.trim() as `0x${string}` | undefined;
    if (!address) {
      console.log(`  ${persona.agentId}: ${persona.addressEnv} not set, skipping`);
      continue;
    }
    const [eth, usdc] = await Promise.all([
      client.getBalance({ address }),
      client.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [address] }) as Promise<bigint>,
    ]);
    console.log(`  ${persona.emoji} ${persona.agentId} ${address}`);
    console.log(`     before: ${weiToEth(eth).toFixed(4)} ETH · ${unitsToUsdc(usdc).toFixed(2)} USDC`);

    // Idempotent by balance, so re-running does not double-fund a healthy wallet.
    if (eth < parseEther(GAS_ETH) / 2n) {
      const tx = await wallet.sendTransaction({
        account: funder.account, to: address, value: parseEther(GAS_ETH), chain: null,
      });
      await client.waitForTransactionReceipt({ hash: tx });
      console.log(`     gas  → ${getExplorerTxUrl(tx)}`);
    } else console.log("     gas  → already funded");

    if (unitsToUsdc(usdc) < Number(STAKE_USDC) / 2) {
      const tx = await transferUsdc({ wallet: funder, to: address, amountUsdc: STAKE_USDC });
      console.log(`     usdc → ${getExplorerTxUrl(tx)}`);
    } else console.log("     usdc → already funded");
  }
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("fund-traders failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
