/**
 * Claim test collateral from the protocol faucet, then distribute native gas
 * and collateral from the creator wallet to every configured worker.
 *
 *   npm run agents:faucet
 *
 * Overrides:
 *   FAUCET_USDC=10000       amount claimed by the creator
 *   FUND_WORKER_USDC=20     target collateral per worker
 *   FUND_ORACLE_STT=5       target native gas for the oracle
 *   FUND_WORKER_STT=2       target native gas for other workers
 *   FUNDING_RESERVE_STT=20  creator gas reserve after native transfers
 *   FUNDING_DRY_RUN=1       show the plan without sending transactions
 */

import { formatEther, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TRADER_PERSONAS } from "../agents/traders/personas";
import {
  listCouncilPersonas,
  personaPrivateKeyEnv,
} from "../agents/council/personas";
import {
  PHILOSOPHER_PERSONAS,
  philosopherPrivateKeyEnv,
} from "../agents/council/philosophers";
import { createExchange } from "../lib/dreamdex";
import {
  createSomniaPublicClient,
  createSomniaWalletClientWithKey,
  somniaShannon,
  weiToStt,
} from "../lib/chain";
import { ERC20_ABI, USDC_ADDRESS, unitsToUsdc, usdcToUnits } from "../lib/usdc";

const CREATOR_ADDRESS = process.env.CREATOR_ADDRESS?.trim().toLowerCase();
const FAUCET_USDC = usdcToUnits(Number(process.env.FAUCET_USDC ?? "10000"));
const WORKER_USDC = usdcToUnits(Number(process.env.FUND_WORKER_USDC ?? "20"));
const ORACLE_STT = parseEther(process.env.FUND_ORACLE_STT ?? "5");
const WORKER_STT = parseEther(process.env.FUND_WORKER_STT ?? "2");
const RESERVE_STT = parseEther(process.env.FUNDING_RESERVE_STT ?? "20");
const DRY_RUN = process.env.FUNDING_DRY_RUN === "1";

type Worker = {
  label: string;
  keyEnv: string;
  sttTarget: bigint;
  address: `0x${string}`;
};

function requiredKey(name: string): `0x${string}` {
  const value = process.env[name]?.trim();
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value as `0x${string}`;
}

function worker(label: string, keyEnv: string, sttTarget: bigint): Worker {
  const key = requiredKey(keyEnv);
  return { label, keyEnv, sttTarget, address: privateKeyToAccount(key).address };
}

function allWorkers(): Worker[] {
  const workers = [worker("oracle", "ORACLE_PRIVATE_KEY", ORACLE_STT)];
  for (const persona of listCouncilPersonas()) {
    workers.push(worker(`council:${persona.slug}`, personaPrivateKeyEnv(persona), WORKER_STT));
  }
  for (const persona of PHILOSOPHER_PERSONAS) {
    workers.push(worker(`philosopher:${persona.slug}`, philosopherPrivateKeyEnv(persona.slug), WORKER_STT));
  }
  for (const persona of TRADER_PERSONAS) {
    workers.push(worker(`trader:${persona.agentId}`, persona.keyEnv, WORKER_STT));
  }
  return workers;
}

async function tokenBalance(client: ReturnType<typeof createSomniaPublicClient>, address: `0x${string}`): Promise<bigint> {
  return await client.readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [address],
  }) as bigint;
}

async function main(): Promise<void> {
  const creatorKey = requiredKey("CREATOR_PRIVATE_KEY");
  const creator = privateKeyToAccount(creatorKey);
  if (CREATOR_ADDRESS && CREATOR_ADDRESS !== creator.address.toLowerCase()) {
    throw new Error(`CREATOR_ADDRESS does not match CREATOR_PRIVATE_KEY (${creator.address})`);
  }

  const workers = allWorkers();
  const unique = new Set(workers.map((entry) => entry.address.toLowerCase()));
  if (unique.size !== workers.length) throw new Error("Duplicate worker address detected");

  const client = createSomniaPublicClient();
  const wallet = createSomniaWalletClientWithKey(creatorKey);
  const creatorStt = await client.getBalance({ address: creator.address });
  const creatorUsdc = await tokenBalance(client, creator.address);
  const nativeNeeds = await Promise.all(workers.map(async (entry) => {
    const balance = await client.getBalance({ address: entry.address });
    return { entry, balance, need: balance < entry.sttTarget ? entry.sttTarget - balance : 0n };
  }));
  const nativeOutflow = nativeNeeds.reduce((sum, entry) => sum + entry.need, 0n);

  console.log(`Creator: ${creator.address}`);
  console.log(`Creator STT: ${weiToStt(creatorStt).toFixed(4)}`);
  console.log(`Creator USDC: ${unitsToUsdc(creatorUsdc).toFixed(2)}`);
  console.log(`Workers: ${workers.length}`);
  console.log(`USDC token: ${USDC_ADDRESS}`);
  console.log(`Planned native outflow: ${weiToStt(nativeOutflow).toFixed(4)} STT`);

  if (creatorStt < nativeOutflow + RESERVE_STT) {
    throw new Error(
      `Creator STT too low: need ${weiToStt(nativeOutflow + RESERVE_STT).toFixed(4)} STT including reserve`,
    );
  }
  if (DRY_RUN) {
    console.log("Dry run: no transactions sent.");
    return;
  }

  for (const entry of nativeNeeds) {
    if (entry.need === 0n) {
      console.log(`STT ok ${entry.entry.label} (${weiToStt(entry.balance).toFixed(4)})`);
      continue;
    }
    const hash = await wallet.sendTransaction({
      account: creator,
      to: entry.entry.address,
      value: entry.need,
      chain: somniaShannon,
    });
    await client.waitForTransactionReceipt({ hash });
    console.log(`STT sent ${entry.entry.label}: +${weiToStt(entry.need).toFixed(4)} (${hash})`);
  }

  const totalNeeded = WORKER_USDC * BigInt(workers.length);
  let refreshedCreatorUsdc = await tokenBalance(client, creator.address);
  if (refreshedCreatorUsdc < totalNeeded) {
    const exchange = createExchange({ privateKey: creatorKey });
    try {
      const faucetTx = await exchange.client.createTrader({ privateKey: creatorKey }).faucet({ amount: FAUCET_USDC });
      console.log(`Faucet claimed ${unitsToUsdc(FAUCET_USDC).toFixed(2)} USDC (${faucetTx.txHash ?? "submitted"})`);
    } finally {
      await exchange.close().catch(() => undefined);
    }
    refreshedCreatorUsdc = await tokenBalance(client, creator.address);
  } else {
    console.log(`Faucet skipped: creator already has ${unitsToUsdc(refreshedCreatorUsdc).toFixed(2)} USDC`);
  }

  if (refreshedCreatorUsdc < totalNeeded) {
    throw new Error(
      `Creator USDC too low after faucet: have ${unitsToUsdc(refreshedCreatorUsdc).toFixed(2)}, need ${unitsToUsdc(totalNeeded).toFixed(2)}`,
    );
  }

  for (const entry of workers) {
    const current = await tokenBalance(client, entry.address);
    if (current >= WORKER_USDC) {
      console.log(`USDC ok ${entry.label} (${unitsToUsdc(current).toFixed(2)})`);
      continue;
    }
    const need = WORKER_USDC - current;
    const hash = await wallet.writeContract({
      account: creator,
      address: USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [entry.address, need],
      chain: somniaShannon,
    });
    await client.waitForTransactionReceipt({ hash });
    console.log(`USDC sent ${entry.label}: +${unitsToUsdc(need).toFixed(2)} (${hash})`);
  }

  const finalStt = await client.getBalance({ address: creator.address });
  const finalUsdc = await tokenBalance(client, creator.address);
  console.log(`Done. Creator remaining: ${formatEther(finalStt)} STT + ${unitsToUsdc(finalUsdc).toFixed(2)} USDC`);
}

main().catch((error) => {
  console.error("faucet-and-distribute failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
