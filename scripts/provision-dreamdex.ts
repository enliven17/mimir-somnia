import { createPublicClient, createWalletClient, decodeEventLog, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { getSomniaRpcUrl } from "../lib/somnia";

const factoryAbi = parseAbi([
  "function createMarketCreator(address owner, address core, address adapter, uint32 operatorId, bytes32 venueId, (uint256 tickSize, uint256 minQuantity, uint256 lotSize) defaultBookParams) returns (address creator, address policy)",
  "event MarketCreatorCreated(address indexed creator, address indexed owner, uint32 indexed operatorId, bytes32 venueId, address policy, address core, address adapter)",
]);

const creatorAbi = parseAbi([
  "function owner() view returns (address)",
  "function seriesById(uint32) view returns (address collateral, string asset, uint64 numericDecimals, uint64 intervalSec, uint64 settlementWindow)",
  "function registerSeries(uint32 seriesId, (address collateral, string asset, uint64 numericDecimals, uint64 intervalSec, uint64 settlementWindow) s)",
]);

const creatorKey = process.env.CREATOR_PRIVATE_KEY?.trim();
if (!creatorKey) throw new Error("CREATOR_PRIVATE_KEY is required");

const account = privateKeyToAccount(creatorKey as `0x${string}`);
const rpcUrl = getSomniaRpcUrl();
const publicClient = createPublicClient({
  chain: somniaShannon,
  transport: http(rpcUrl, { timeout: 15_000 }),
});
const walletClient = createWalletClient({
  account,
  chain: somniaShannon,
  transport: http(rpcUrl, { timeout: 15_000 }),
});

const venueId = "0xd5fc2dc5e0133842011dfc657ce39cb3a4534f4fc368e23af5b23594eeeac6d7" as `0x${string}`;
const bookParams = {
  tickSize: 1_000_000_000_000n,
  minQuantity: 1_000_000_000_000_000_000n,
  lotSize: 1_000_000_000_000_000_000n,
};

async function main() {
  const configured = process.env.DREAMDEX_MARKET_CREATOR_ADDRESS?.trim();
  if (configured) {
    const creator = configured as `0x${string}`;
    const [owner, series] = await Promise.all([
      publicClient.readContract({ address: creator, abi: creatorAbi, functionName: "owner" }),
      publicClient.readContract({ address: creator, abi: creatorAbi, functionName: "seriesById", args: [305] }),
    ]);
    const valid = owner.toLowerCase() === account.address.toLowerCase()
      && series[0].toLowerCase() === SOMNIA_TESTNET_ADDRESSES.collateral!.toLowerCase()
      && series[1] === "SOMI"
      && series[2] === 8n
      && series[3] === 300n
      && series[4] === 300n;
    if (!valid) throw new Error("configured DREAMDEX_MARKET_CREATOR_ADDRESS does not match the expected owner or series");
    console.log(JSON.stringify({ creator, seriesId: 305, status: "already-configured" }));
    return;
  }

  const balance = await publicClient.getBalance({ address: account.address });
  if (balance < 2n * 10n ** 18n) throw new Error("CREATOR_ADDRESS needs at least 2 STT before provisioning");

  const createHash = await walletClient.writeContract({
    address: SOMNIA_TESTNET_ADDRESSES.marketCreatorFactory!,
    abi: factoryAbi,
    functionName: "createMarketCreator",
    args: [
      account.address,
      SOMNIA_TESTNET_ADDRESSES.binaryModule!,
      SOMNIA_TESTNET_ADDRESSES.oracleHub!,
      2,
      venueId,
      bookParams,
    ],
    gas: 100_000_000n,
  });
  const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash, timeout: 120_000 });
  if (createReceipt.status !== "success") throw new Error(`creator creation reverted: ${createHash}`);
  const event = createReceipt.logs
    .map((log) => {
      try {
        return decodeEventLog({ abi: factoryAbi, data: log.data, topics: log.topics });
      } catch {
        return null;
      }
    })
    .find((decoded) => decoded?.eventName === "MarketCreatorCreated");
  const creator = event?.args?.creator as `0x${string}` | undefined;
  if (!creator) throw new Error("MarketCreatorCreated event was not found");

  const seriesHash = await walletClient.writeContract({
    address: creator,
    abi: creatorAbi,
    functionName: "registerSeries",
    args: [305, {
      collateral: SOMNIA_TESTNET_ADDRESSES.collateral!,
      asset: "SOMI",
      numericDecimals: 8n,
      intervalSec: 300n,
      settlementWindow: 300n,
    }],
    gas: 10_000_000n,
  });
  await publicClient.waitForTransactionReceipt({ hash: seriesHash, timeout: 120_000 });

  const fundHash = await walletClient.sendTransaction({
    to: creator,
    value: 5n * 10n ** 18n,
    gas: 100_000n,
  });
  await publicClient.waitForTransactionReceipt({ hash: fundHash, timeout: 120_000 });

  console.log(JSON.stringify({ creator, seriesId: 305, createHash, seriesHash, fundHash }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
