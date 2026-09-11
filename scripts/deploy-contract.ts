/**
 * Deploy contracts/MimirV2.sol to Somnia Shannon.
 *
 *   node scripts/compile-contract.mjs MimirV2
 *   npx tsx --env-file-if-exists=.env.local scripts/deploy-contract.ts          # plan only
 *   DEPLOY_CONFIRM=1 npx tsx --env-file-if-exists=.env.local scripts/deploy-contract.ts
 *
 * Constructor arguments default to whatever the currently configured contract
 * reports, so a redeploy continues the same setup instead of quietly changing
 * the oracle, the collateral or the fee policy. Override any of them with
 * DEPLOY_ORACLE / DEPLOY_USDC / DEPLOY_PLATFORM_FEE_BPS /
 * DEPLOY_AGENT_FEE_BPS / DEPLOY_FEE_RECIPIENT.
 *
 * The deployer becomes `owner`, so this uses CREATOR_PRIVATE_KEY by default —
 * the key that owns the existing deployment. Deploying from a different key
 * silently moves ownership.
 *
 * Prints the new address and its block, which are what
 * NEXT_PUBLIC_CONTRACT_ADDRESS and NEXT_PUBLIC_DEPLOY_BLOCK must be set to.
 * A fresh contract starts at claimCount 0: any existing claims stay with the
 * old address and are not migrated.
 */

import { readFileSync } from "node:fs";
import { formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  createSomniaPublicClient,
  createSomniaWalletClientWithKey,
  getContractAddress,
  isContractConfigured,
  somniaShannon,
  weiToStt,
} from "../lib/chain";

const CONFIG_ABI = [
  { type: "function", name: "oracle", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "usdc", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  {
    type: "function",
    name: "feePolicy",
    inputs: [],
    outputs: [
      { name: "platformFeeBps", type: "uint16" },
      { name: "agentOwnerFeeBps", type: "uint16" },
      { name: "platformRecipient", type: "address" },
    ],
    stateMutability: "view",
  },
] as const;

function requireKey(): `0x${string}` {
  const name = process.env.DEPLOY_KEY_ENV?.trim() || "CREATOR_PRIVATE_KEY";
  const key = process.env[name]?.trim();
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(`${name} is unset or malformed — set it, or point DEPLOY_KEY_ENV at another key`);
  }
  return key as `0x${string}`;
}

function envAddress(name: string): `0x${string}` | null {
  const raw = process.env[name]?.trim();
  return raw && /^0x[0-9a-fA-F]{40}$/.test(raw) ? (raw as `0x${string}`) : null;
}

async function main(): Promise<void> {
  const artifact = JSON.parse(readFileSync("deploy/artifacts/MimirV2.json", "utf8")) as {
    abi: unknown[];
    bytecode: `0x${string}`;
    deployedBytecode: string;
    compiler: unknown;
  };

  const publicClient = createSomniaPublicClient();
  const key = requireKey();
  const account = privateKeyToAccount(key);

  // Defaults come from the live contract so a redeploy cannot drift.
  let current: { oracle: `0x${string}`; usdc: `0x${string}`; fees: readonly [number, number, `0x${string}`] } | null = null;
  if (isContractConfigured()) {
    const address = getContractAddress();
    try {
      const [oracle, usdc, fees] = await Promise.all([
        publicClient.readContract({ address, abi: CONFIG_ABI, functionName: "oracle" }),
        publicClient.readContract({ address, abi: CONFIG_ABI, functionName: "usdc" }),
        publicClient.readContract({ address, abi: CONFIG_ABI, functionName: "feePolicy" }),
      ]);
      current = { oracle, usdc, fees: fees as readonly [number, number, `0x${string}`] };
      console.log(`Existing contract ${address}`);
      console.log(`  oracle ${oracle}`);
      console.log(`  usdc   ${usdc}`);
      console.log(`  fees   platform=${fees[0]}bps agentOwner=${fees[1]}bps recipient=${fees[2]}`);
    } catch {
      console.warn("Could not read the existing contract; falling back to env for constructor args.");
    }
  }

  const oracle = envAddress("DEPLOY_ORACLE") ?? current?.oracle ?? envAddress("ORACLE_ADDRESS");
  const usdc = envAddress("DEPLOY_USDC") ?? current?.usdc ?? envAddress("NEXT_PUBLIC_COLLATERAL_ADDRESS");
  const platformFeeBps = Number(process.env.DEPLOY_PLATFORM_FEE_BPS ?? current?.fees[0] ?? 0);
  const agentFeeBps = Number(process.env.DEPLOY_AGENT_FEE_BPS ?? current?.fees[1] ?? 0);
  const feeRecipient =
    envAddress("DEPLOY_FEE_RECIPIENT") ?? current?.fees[2] ?? account.address;

  if (!oracle) throw new Error("No oracle address: set DEPLOY_ORACLE or ORACLE_ADDRESS");
  if (!usdc) throw new Error("No collateral address: set DEPLOY_USDC or NEXT_PUBLIC_COLLATERAL_ADDRESS");

  const args = [oracle, usdc, platformFeeBps, agentFeeBps, feeRecipient] as const;
  const balance = await publicClient.getBalance({ address: account.address });

  console.log("\nDeploying MimirV2");
  console.log(`  chain     ${somniaShannon.name} (${somniaShannon.id})`);
  console.log(`  deployer  ${account.address}  ${weiToStt(balance).toFixed(4)} STT`);
  console.log(`  runtime   ${(artifact.deployedBytecode.length - 2) / 2} bytes`);
  console.log(`  args      oracle=${oracle}`);
  console.log(`            usdc=${usdc}`);
  console.log(`            platformFeeBps=${platformFeeBps} agentOwnerFeeBps=${agentFeeBps}`);
  console.log(`            platformRecipient=${feeRecipient}`);

  const gas = await publicClient.estimateGas({
    account,
    data: (artifact.bytecode +
      // Constructor args are appended to the creation bytecode; viem does this
      // for deployContract, but estimating needs the same calldata shape.
      (await import("viem")).encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "uint16" }, { type: "uint16" }, { type: "address" }],
        [oracle, usdc, platformFeeBps, agentFeeBps, feeRecipient],
      ).slice(2)) as `0x${string}`,
  });
  const gasPrice = await publicClient.getGasPrice();
  const cost = gas * gasPrice;
  console.log(`  gas       ${gas} at ${formatEther(gasPrice)} → ~${weiToStt(cost).toFixed(5)} STT`);

  if (cost > balance) {
    throw new Error(
      `Deployer holds ${weiToStt(balance).toFixed(4)} STT but the deploy needs ~${weiToStt(cost).toFixed(4)}`,
    );
  }

  if (process.env.DEPLOY_CONFIRM !== "1") {
    console.log("\nPlan only. Re-run with DEPLOY_CONFIRM=1 to send.");
    return;
  }

  const wallet = createSomniaWalletClientWithKey(key);
  const hash = await wallet.deployContract({
    abi: artifact.abi as never,
    bytecode: artifact.bytecode,
    args: args as never,
    account,
    chain: somniaShannon,
  });
  console.log(`\nsent ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`Deployment reverted (status ${receipt.status})`);
  }

  console.log(`\nDeployed at ${receipt.contractAddress}`);
  console.log(`  block ${receipt.blockNumber}`);
  console.log(`  gas used ${receipt.gasUsed}`);
  console.log("\nSet these, in .env.local and on every deployed service:");
  console.log(`  NEXT_PUBLIC_CONTRACT_ADDRESS=${receipt.contractAddress}`);
  console.log(`  NEXT_PUBLIC_DEPLOY_BLOCK=${receipt.blockNumber}`);
}

main().catch((error) => {
  console.error("deploy failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
