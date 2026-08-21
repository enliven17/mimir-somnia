/**
 * Post-deploy on-chain smoke (USDC stakes):
 *   1. Read oracle / usdc / claimCount
 *   2. Creator createClaim (2 USDC, short deadline)
 *   3. Oracle challengeClaim (2 USDC)
 *   4. Read claim state
 *
 *   npx tsx --env-file=.env.local scripts/onchain-smoke.ts
 */
import {
  decodeEventLog,
} from "viem";
import {
  createSomniaPublicClient,
  getContractAddress,
  getExplorerTxUrl,
  weiToStt,
} from "../lib/chain";
import { agentContractWrite, getCreatorWallet, getOracleWallet } from "../lib/agent-wallets";
import { MIMIR_ABI, STATE } from "../lib/mimir-abi";
import { ERC20_ABI, USDC_ADDRESS, formatAtomicUsdc, parseUsdcAtomic } from "../lib/usdc";
import { fetchDecodedClaim } from "../lib/claim-codec";

function cleanKeys() {
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string" && v.includes("#")) {
      process.env[k] = v.split(/\s+#/)[0].trim();
    }
  }
}

async function main() {
  cleanKeys();
  const client = createSomniaPublicClient();
  const contract = getContractAddress();
  const creator = getCreatorWallet();
  const oracle = getOracleWallet();

  console.log("── On-chain smoke ──");
  console.log(`Contract: ${contract}`);
  console.log(`USDC    : ${USDC_ADDRESS}`);
  console.log(`Creator : ${creator.address}`);
  console.log(`Oracle  : ${oracle.address}`);

  const [onOracle, onUsdc, claimCount] = await Promise.all([
    client.readContract({ address: contract, abi: MIMIR_ABI, functionName: "oracle" }) as Promise<`0x${string}`>,
    client.readContract({ address: contract, abi: MIMIR_ABI, functionName: "usdc" }) as Promise<`0x${string}`>,
    client.readContract({ address: contract, abi: MIMIR_ABI, functionName: "claimCount" }) as Promise<bigint>,
  ]);

  console.log(`\n[1] config`);
  console.log(`  oracle()     = ${onOracle}`);
  console.log(`  usdc()       = ${onUsdc}`);
  console.log(`  claimCount() = ${claimCount}`);

  if (onOracle.toLowerCase() !== oracle.address.toLowerCase()) {
    throw new Error(`oracle mismatch: contract=${onOracle} expected=${oracle.address}`);
  }
  if (onUsdc.toLowerCase() !== USDC_ADDRESS.toLowerCase()) {
    throw new Error(`usdc mismatch: contract=${onUsdc} expected=${USDC_ADDRESS}`);
  }
  console.log("  ✓ oracle + usdc match");

  const stake = parseUsdcAtomic("2");
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  console.log(`\n[2] createClaim (2 USDC)…`);
  const createTx = await agentContractWrite({
    wallet: creator,
    contractAddress: contract,
    abi: MIMIR_ABI,
    functionName: "createClaim",
    args: [[
      "Onchain smoke — will this claim be challengeable?",
      "Yes",
      "No",
      "https://example.com/smoke",
      deadline,
      stake,
      "custom",
      0n,
      "binary",
      "pool",
      0n,
      "",
      "Smoke test only — not for real settlement",
      100n,
      false,
      "",
      `0x${"00".repeat(32)}`,
      "0x0000000000000000000000000000000000000000",
    ]],
    amountUsdc: "2",
  });
  console.log(`  create: ${getExplorerTxUrl(createTx)}`);

  const receipt = await client.getTransactionReceipt({ hash: createTx });
  const createdEvent = receipt.logs
    .map((log) => {
      try {
        return decodeEventLog({ abi: MIMIR_ABI, eventName: "ClaimCreated", data: log.data, topics: log.topics });
      } catch {
        return null;
      }
    })
    .find(Boolean);
  if (!createdEvent || !("id" in createdEvent.args)) throw new Error("ClaimCreated event missing from create receipt");
  const claimId = Number(createdEvent.args.id);

  // Public testnet RPCs can briefly serve a stale read immediately after a receipt.
  // Wait until the exact claim is visible before simulating the dependent write.
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const visibleCount = (await client.readContract({
      address: contract,
      abi: MIMIR_ABI,
      functionName: "claimCount",
    })) as bigint;
    if (visibleCount >= BigInt(claimId)) break;
    if (attempt === 14) throw new Error(`claim #${claimId} not visible after create receipt`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  console.log(`  claimId = #${claimId}`);

  console.log(`\n[3] challengeClaim (2 USDC from oracle)…`);
  const challengeTx = await agentContractWrite({
    wallet: oracle,
    contractAddress: contract,
    abi: MIMIR_ABI,
    functionName: "challengeClaim",
    args: [BigInt(claimId), stake, ""],
    amountUsdc: "2",
  });
  console.log(`  challenge: ${getExplorerTxUrl(challengeTx)}`);

  console.log(`\n[4] read claim…`);
  let decoded = await fetchDecodedClaim(client, contract, claimId);
  for (let attempt = 0; attempt < 15 && decoded && Number(decoded.state) !== STATE.ACTIVE; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    decoded = await fetchDecodedClaim(client, contract, claimId);
  }
  if (!decoded) throw new Error("claim not found after create");

  console.log(`  state            = ${decoded.state} (expect ACTIVE=${STATE.ACTIVE})`);
  console.log(`  creatorStake     = ${formatAtomicUsdc(decoded.creatorStake)} USDC`);
  console.log(`  challengerStake  = ${formatAtomicUsdc(decoded.totalChallengerStake)} USDC`);
  console.log(`  challengerCount  = ${decoded.challengerCount}`);

  if (Number(decoded.state) !== STATE.ACTIVE) {
    throw new Error(`expected ACTIVE, got ${decoded.state}`);
  }
  if (BigInt(decoded.challengerCount) < 1n) throw new Error("expected at least 1 challenger");
  if (decoded.creatorStake !== stake) {
    throw new Error(`creator stake expected 2 USDC, got ${formatAtomicUsdc(decoded.creatorStake)}`);
  }
  if (decoded.totalChallengerStake !== stake) {
    throw new Error(`challenger stake expected 2 USDC, got ${formatAtomicUsdc(decoded.totalChallengerStake)}`);
  }

  const pot = (await client.readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [contract],
  })) as bigint;
  console.log(`  contract USDC bal = ${formatAtomicUsdc(pot)} (expect at least 4)`);
  if (pot < stake * 2n) throw new Error("contract should hold at least the 4 USDC smoke pot");

  const creatorEth = await client.getBalance({ address: creator.address });
  const oracleEth = await client.getBalance({ address: oracle.address });
  console.log(`\n  creator gas left: ${weiToStt(creatorEth).toFixed(4)} ETH`);
  console.log(`  oracle  gas left: ${weiToStt(oracleEth).toFixed(4)} ETH`);

  console.log("\n✓ ON-CHAIN SMOKE PASSED");
}

main().catch((err) => {
  console.error("onchain-smoke FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
