/**
 * Fund the twelve Mimir agent wallets from one master key.
 *
 *   FUNDER_PRIVATE_KEY=0x... npx tsx --env-file=.env.local scripts/fund-agents.ts
 *
 * Sends:
 *   - native ETH for gas (FUND_GAS_ETH, default 1)
 *   - USDC for stakes (FUND_AMOUNT_USDC / FUND_COUNCIL_AMOUNT_USDC, defaults 20 / 10)
 *
 * The funder must hold both Somnia Shannon testnet ETH (faucet) and test USDC.
 * USDC: 0x75edC9335175Fc0552D51D48439F229c10420fe3
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
import {
  PHILOSOPHER_PERSONAS,
  philosopherPrivateKeyEnv,
} from "../agents/council/philosophers";
import { ERC20_ABI, USDC_ADDRESS, usdcToUnits, unitsToUsdc } from "../lib/usdc";

const GAS_ETH = parseEther(process.env.FUND_GAS_ETH ?? "1");
const USDC_CORE = usdcToUnits(Number(process.env.FUND_AMOUNT_USDC ?? "20"));
const USDC_COUNCIL = usdcToUnits(Number(process.env.FUND_COUNCIL_AMOUNT_USDC ?? "10"));

function bigintMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

async function main(): Promise<void> {
  const funderKey = process.env.FUNDER_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
  if (!funderKey || !/^0x[0-9a-fA-F]{64}$/.test(funderKey)) {
    console.error("FUNDER_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY) is required — a 0x-prefixed 32-byte hex key.");
    process.exit(1);
  }

  const publicClient = createSomniaPublicClient();
  const funder = privateKeyToAccount(funderKey as `0x${string}`);
  const wallet = createSomniaWalletClientWithKey(funderKey);

  const targets: Array<{
    label: string;
    address: `0x${string}`;
    gas: bigint;
    usdc: bigint;
  }> = [];

  const addTarget = (label: string, keyEnv: string, usdc: bigint) => {
    const key = process.env[keyEnv]?.trim();
    if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
      console.warn(`  · skip ${label} — ${keyEnv} not set`);
      return;
    }
    targets.push({
      label,
      address: privateKeyToAccount(key as `0x${string}`).address,
      gas: GAS_ETH,
      usdc,
    });
  };

  addTarget("oracle", "ORACLE_PRIVATE_KEY", USDC_CORE);
  addTarget("market-creator", "CREATOR_PRIVATE_KEY", USDC_CORE);
  for (const persona of listCouncilPersonas()) {
    addTarget(`council:${persona.slug}`, personaPrivateKeyEnv(persona), USDC_COUNCIL);
  }
  // Each philosopher is funded to its own declared stake limit rather than the
  // shared council figure: a persona whose rubric routinely abstains does not need
  // the same float as one that stakes on every claim.
  for (const persona of PHILOSOPHER_PERSONAS) {
    addTarget(
      `philosopher:${persona.slug}`,
      philosopherPrivateKeyEnv(persona.slug),
      // Atomic units on both sides of the min: mixing USDC and units here would
      // fund a persona a millionth of what it needs.
      bigintMin(
        USDC_COUNCIL,
        usdcToUnits(persona.limits.maxStakeUsdc * persona.limits.maxClaimsPerCycle),
      ),
    );
  }

  const funderEth = await publicClient.getBalance({ address: funder.address });
  const funderUsdc = (await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [funder.address],
  })) as bigint;

  console.log(`Funder     : ${funder.address}`);
  console.log(`  ETH gas  : ${weiToStt(funderEth).toFixed(4)} ETH`);
  console.log(`  USDC     : ${unitsToUsdc(funderUsdc).toFixed(2)} USDC  (${USDC_ADDRESS})`);
  console.log(`Targets    : ${targets.length} wallets`);
  console.log(`Per core   : ${formatEther(GAS_ETH)} ETH gas + ${unitsToUsdc(USDC_CORE)} USDC`);
  console.log(`Per council: ${formatEther(GAS_ETH)} ETH gas + ${unitsToUsdc(USDC_COUNCIL)} USDC\n`);

  for (const t of targets) {
    // Gas (native ETH)
    const ethBal = await publicClient.getBalance({ address: t.address });
    if (ethBal < t.gas) {
      const hash = await wallet.sendTransaction({
        account: funder,
        to: t.address,
        value: t.gas,
        chain: somniaShannon,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      console.log(`  ✓ ${t.label.padEnd(24)} +${formatEther(t.gas)} ETH gas — ${getExplorerTxUrl(hash)}`);
    } else {
      console.log(`  · ${t.label.padEnd(24)} gas ok (${weiToEth(ethBal).toFixed(4)} ETH)`);
    }

    // Stake token (USDC)
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
      console.log(`  ✓ ${t.label.padEnd(24)} +${unitsToUsdc(need).toFixed(2)} USDC — ${getExplorerTxUrl(hash)}`);
    } else {
      console.log(`  · ${t.label.padEnd(24)} USDC ok (${unitsToUsdc(usdcBal).toFixed(2)} USDC)`);
    }
  }

  console.log("\nDone. Balances: npm run agents:balances");
}

main().catch((err) => {
  console.error("fund-agents failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
