import { parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  createSomniaPublicClient,
  createSomniaWalletClientWithKey,
  somniaShannon,
  getExplorerTxUrl,
  weiToStt,
} from "../lib/chain";
import { ERC20_ABI, USDC_ADDRESS, usdcToUnits, unitsToUsdc } from "../lib/usdc";

const clean = (n: string) => (process.env[n] || "").split(/\s+#/)[0].trim();

async function main() {
  const funderKey = clean("ORACLE_PRIVATE_KEY");
  const funder = privateKeyToAccount(funderKey as `0x${string}`);
  const wallet = createSomniaWalletClientWithKey(funderKey);
  const client = createSomniaPublicClient();
  const to = "0xF1c89564E4e871088f35152f32991eb7EbCA4E8b" as const;

  const bot = await client.getBalance({ address: funder.address });
  const usdc = (await client.readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [funder.address],
  })) as bigint;
  console.log(`oracle ETH ${weiToStt(bot).toFixed(4)}  USDC ${unitsToUsdc(usdc).toFixed(2)}`);

  const leave = parseEther("0.05");
  let sendEth = 0n;
  if (bot > leave + parseEther("0.2")) sendEth = parseEther("0.3");
  else if (bot > leave + parseEther("0.1")) sendEth = bot - leave;

  if (sendEth > 0n) {
    const h = await wallet.sendTransaction({
      account: funder,
      to,
      value: sendEth,
      chain: somniaShannon,
    });
    await client.waitForTransactionReceipt({ hash: h });
    console.log(`yapper +${weiToStt(sendEth).toFixed(4)} ETH  ${getExplorerTxUrl(h)}`);
  } else {
    console.log("not enough ETH left for yapper gas — fund oracle gas first");
  }

  const needUsdc = usdcToUnits(30);
  const yUsdc = (await client.readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [to],
  })) as bigint;
  if (yUsdc < needUsdc) {
    const h2 = await wallet.writeContract({
      account: funder,
      address: USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [to, needUsdc - yUsdc],
      chain: somniaShannon,
    });
    await client.waitForTransactionReceipt({ hash: h2 });
    console.log(`yapper +${unitsToUsdc(needUsdc - yUsdc).toFixed(2)} USDC  ${getExplorerTxUrl(h2)}`);
  } else {
    console.log(`yapper USDC ok (${unitsToUsdc(yUsdc).toFixed(2)})`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
