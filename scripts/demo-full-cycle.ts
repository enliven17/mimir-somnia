/**
 * End-to-end demo of the full Mimir cycle on Somnia Shannon testnet with an LLM
 * settling. Stakes are USDC (ERC-20); gas is native ETH.
 *
 *   1. market-creator wallet  → createClaim (2 USDC stake, 150s deadline)
 *   2. oracle wallet          → challengeClaim (2 USDC counter-stake)
 *   3. wait for deadline
 *   4. oracle wallet (LLM)    → resolveClaim with on-chain payout
 *
 * Run: npx tsx --env-file=.env.local scripts/demo-full-cycle.ts
 */

import { keccak256, toBytes } from "viem";
import {
  createSomniaPublicClient, getContractAddress, getExplorerTxUrl, weiToStt,
} from "../lib/chain";
import {
  agentContractWrite, getCreatorWallet, getOracleWallet,
} from "../lib/agent-wallets";
import { callLLM, activeLLMProvider, activeLLMModel } from "../lib/llm";
import { MIMIR_ABI, STATE, WINNER_SIDE } from "../lib/mimir-abi";
import { ERC20_ABI, USDC_ADDRESS, usdcToUnits, unitsToUsdc } from "../lib/usdc";

const DEADLINE_SECONDS = 150;
const STAKE_USDC       = 2;

async function main(): Promise<void> {
  const client          = createSomniaPublicClient();
  const contractAddress = getContractAddress();
  const oracle          = getOracleWallet();
  const creator         = getCreatorWallet();

  console.log("─── Mimir full-cycle demo (USDC stakes) ───");
  console.log(`Contract: ${contractAddress}`);
  console.log(`USDC    : ${USDC_ADDRESS}`);
  console.log(`LLM     : ${activeLLMProvider()} / ${activeLLMModel()}`);
  console.log(`Creator : ${creator.address}`);
  console.log(`Oracle  : ${oracle.address}`);

  const stakeUnits = usdcToUnits(STAKE_USDC);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);

  // 1. CREATE
  console.log(`\n[1/4] Creating claim (deadline in ${DEADLINE_SECONDS}s, stake ${STAKE_USDC} USDC)…`);
  const createTx = await agentContractWrite({
    wallet:          creator,
    contractAddress,
    abi:             MIMIR_ABI,
    functionName:    "createClaim",
    args: [[
      "Mimir demo — is the Bitcoin price > $100,000 USD?",
      "Yes, BTC > $100k",
      "No, BTC ≤ $100k",
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
      deadline,
      stakeUnits,
      "crypto",
      0n, "binary", "pool", 0n, "",
      "Settle from CoinGecko BTC USD spot price at deadline",
      100n, false, "",
      `0x${"00".repeat(32)}`,
      "0x0000000000000000000000000000000000000000",
    ]],
    amountUsdc: String(STAKE_USDC),
  });
  console.log(`  create tx: ${getExplorerTxUrl(createTx)}`);

  const claimCount = (await client.readContract({
    address: contractAddress, abi: MIMIR_ABI, functionName: "claimCount",
  })) as bigint;
  const claimId = claimCount;
  console.log(`  claim id : #${claimId}`);

  // 2. CHALLENGE
  console.log(`\n[2/4] Oracle challenges (stakes ${STAKE_USDC} USDC on Side B)…`);
  const challengeTx = await agentContractWrite({
    wallet:          oracle,
    contractAddress,
    abi:             MIMIR_ABI,
    functionName:    "challengeClaim",
    args:            [claimId, stakeUnits, ""],
    amountUsdc:      String(STAKE_USDC),
  });
  console.log(`  challenge tx: ${getExplorerTxUrl(challengeTx)}`);

  // 3. WAIT
  const waitMs = (DEADLINE_SECONDS + 5) * 1000;
  console.log(`\n[3/4] Waiting ${Math.ceil(waitMs / 1000)}s for deadline…`);
  await new Promise((r) => setTimeout(r, waitMs));

  // 4. RESOLVE
  console.log(`\n[4/4] Oracle resolving via LLM…`);
  const evidence = await (await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
  )).text();
  const evidenceHash = keccak256(toBytes(evidence));

  const llm = await callLLM(
    `Claim: Will BTC price be above $100,000 USD?\nEvidence JSON: ${evidence.slice(0, 500)}\n` +
    `Reply JSON only: {"verdict":"CREATOR_WINS"|"CHALLENGERS_WIN"|"DRAW"|"UNRESOLVABLE","confidence":0-100,"explanation":"..."}`
  );
  let verdict = "UNRESOLVABLE";
  let confidence = 50;
  let summary = "Demo settlement";
  try {
    const parsed = JSON.parse(llm.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    verdict = parsed.verdict ?? verdict;
    confidence = Number(parsed.confidence ?? confidence);
    summary = String(parsed.explanation ?? summary).slice(0, 200);
  } catch { /* use defaults */ }

  const sideMap: Record<string, number> = {
    CREATOR_WINS: WINNER_SIDE.CREATOR,
    CHALLENGERS_WIN: WINNER_SIDE.CHALLENGERS,
    DRAW: WINNER_SIDE.DRAW,
    UNRESOLVABLE: WINNER_SIDE.UNRESOLVABLE,
  };
  const winnerSide = sideMap[verdict] ?? WINNER_SIDE.UNRESOLVABLE;

  const resolveTx = await agentContractWrite({
    wallet:          oracle,
    contractAddress,
    abi:             MIMIR_ABI,
    functionName:    "resolveClaim",
    args:            [claimId, winnerSide, summary, confidence, evidenceHash],
  });
  console.log(`  resolve tx: ${getExplorerTxUrl(resolveTx)}`);
  console.log(`  verdict   : ${verdict} (${confidence}%)`);

  const creatorUsdc = (await client.readContract({
    address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [creator.address],
  })) as bigint;
  const oracleUsdc = (await client.readContract({
    address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [oracle.address],
  })) as bigint;
  const oracleEth = await client.getBalance({ address: oracle.address });
  const creatorEth = await client.getBalance({ address: creator.address });

  console.log("\n─── Done ───");
  console.log(`Creator USDC : ${unitsToUsdc(creatorUsdc).toFixed(2)}  gas ${weiToStt(creatorEth).toFixed(4)} ETH`);
  console.log(`Oracle  USDC : ${unitsToUsdc(oracleUsdc).toFixed(2)}  gas ${weiToStt(oracleEth).toFixed(4)} ETH`);
  void STATE;
}

main().catch((err) => {
  console.error("demo-full-cycle failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
