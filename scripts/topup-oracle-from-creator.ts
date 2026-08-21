/**
 * Move native ETH (gas) from market-creator → oracle.
 * Optional: also top up low-gas council wallets.
 *
 *   npx tsx --env-file=.env.local scripts/topup-oracle-from-creator.ts
 */
import { parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  createSomniaPublicClient,
  createSomniaWalletClientWithKey,
  somniaShannon,
  getExplorerTxUrl,
  weiToStt,
} from "../lib/chain";
const weiToEth = weiToStt;

const clean = (n: string) => (process.env[n] || "").split(/\s+#/)[0].trim();

async function main() {
  const creatorKey = clean("CREATOR_PRIVATE_KEY");
  const oracleKey = clean("ORACLE_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(creatorKey)) throw new Error("CREATOR_PRIVATE_KEY missing");
  if (!/^0x[0-9a-fA-F]{64}$/.test(oracleKey)) throw new Error("ORACLE_PRIVATE_KEY missing");

  const creator = privateKeyToAccount(creatorKey as `0x${string}`);
  const oracle = privateKeyToAccount(oracleKey as `0x${string}`);
  const wallet = createSomniaWalletClientWithKey(creatorKey);
  const client = createSomniaPublicClient();

  const creatorEth = await client.getBalance({ address: creator.address });
  const oracleEth = await client.getBalance({ address: oracle.address });
  console.log(`creator ${creator.address}  ${weiToStt(creatorEth).toFixed(4)} ETH`);
  console.log(`oracle  ${oracle.address}  ${weiToStt(oracleEth).toFixed(4)} ETH`);

  // Leave ~0.3 ETH on creator for its own gas; send rest to oracle (cap 8 ETH)
  const leave = parseEther("0.3");
  const maxSend = parseEther("8");
  let send = creatorEth > leave ? creatorEth - leave : 0n;
  if (send > maxSend) send = maxSend;

  if (send <= parseEther("0.05")) {
    console.log("Nothing meaningful to send (creator low).");
    return;
  }

  const hash = await wallet.sendTransaction({
    account: creator,
    to: oracle.address,
    value: send,
    chain: somniaShannon,
  });
  await client.waitForTransactionReceipt({ hash });
  console.log(`✓ sent ${weiToEth(send).toFixed(4)} ETH → oracle  ${getExplorerTxUrl(hash)}`);

  const afterC = await client.getBalance({ address: creator.address });
  const afterO = await client.getBalance({ address: oracle.address });
  console.log(`creator now ${weiToStt(afterC).toFixed(4)} ETH`);
  console.log(`oracle  now ${weiToStt(afterO).toFixed(4)} ETH`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
