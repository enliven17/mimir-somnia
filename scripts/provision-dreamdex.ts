import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  MARKET_TYPE_BINARY_V1,
  SOMNIA_TESTNET_ADDRESSES,
} from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { getSomniaRpcUrl } from "../lib/somnia";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const SERIES_ID = 1;
const SERIES = {
  asset: "BTC",
  numericDecimals: 2n,
  intervalSec: 900n,
  settlementWindow: 300n,
} as const;
const REACTIVITY = {
  priorityFeePerGas: 1_000_000_000n,
  maxFeePerGas: 10_000_000_000n,
  gasLimit: 200_000_000n,
} as const;
// Somnia's Solidity reactivity subscriptions require a 32 STT creator float.
// Keep the idempotent check at the protocol minimum; callback spending can
// legitimately move a funded creator below the one-time provisioning target.
const CREATOR_MIN_BALANCE = 32n * 10n ** 18n;

const marketsCoreAbi = parseAbi([
  "function registerOperator(address feeRecipient, bool enabled, address policy, bytes context) returns (uint32 operatorId)",
  "function createVenue(uint32 operatorId, bytes4 marketType, (bytes feeParams, address feeRecipientOverride, address policy, address signer, bool creationEnabled, bytes context) config) returns (bytes32 venueId)",
  "event OperatorRegistered(uint32 indexed operatorId, address indexed owner, address indexed feeRecipient, bool enabled, address policy, bytes context)",
  "event VenueCreated(uint32 indexed operatorId, bytes32 indexed venueId, bytes4 indexed marketType, bytes feeParams, address feeRecipientOverride, address policy, address signer, bool creationEnabled, bytes context)",
]);

const factoryAbi = parseAbi([
  "function createMarketCreator(address owner, address core, address adapter, uint32 operatorId, bytes32 venueId, (uint256 tickSize, uint256 minQuantity, uint256 lotSize) defaultBookParams) returns (address creator, address policy)",
  "event MarketCreatorCreated(address indexed creator, address indexed owner, uint32 indexed operatorId, bytes32 venueId, address policy, address core, address adapter)",
]);

const creatorAbi = parseAbi([
  "function owner() view returns (address)",
  "function core() view returns (address)",
  "function operatorId() view returns (uint32)",
  "function venueId() view returns (bytes32)",
  "function marketCount() view returns (uint256)",
  "function reactivityGasLimit() view returns (uint64)",
  "function reactivityMaxFeePerGas() view returns (uint64)",
  "function reactivityPriorityFeePerGas() view returns (uint64)",
  "function firstRollArmed(uint32) view returns (bool)",
  "function seriesById(uint32) view returns (address collateral, string asset, uint64 numericDecimals, uint64 intervalSec, uint64 settlementWindow)",
  "function registerSeries(uint32, (address collateral, string asset, uint64 numericDecimals, uint64 intervalSec, uint64 settlementWindow) s)",
  "function setReactivityGasParams(uint64 priorityFeePerGas, uint64 maxFeePerGas, uint64 gasLimit)",
  "function triggerRoll(uint32)",
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

const bookParams = {
  tickSize: 1_000n,
  minQuantity: 1_000n,
  lotSize: 1_000n,
};

const feeParams = encodeAbiParameters(
  [
    { type: "uint8" },
    {
      type: "tuple",
      components: [
        { name: "makerFeeBps", type: "uint64" },
        { name: "takerFeeBps", type: "uint64" },
        { name: "maxBuilderFeeBps", type: "uint64" },
        { name: "routingFeeBps", type: "uint64" },
        { name: "settlementFeeBps", type: "uint64" },
      ],
    },
  ],
  [2, { makerFeeBps: 0n, takerFeeBps: 0n, maxBuilderFeeBps: 0n, routingFeeBps: 0n, settlementFeeBps: 0n }],
);

async function wait(hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`transaction reverted: ${hash}`);
  return receipt;
}

function decodedEvent(receipt: Awaited<ReturnType<typeof wait>>, abi: typeof marketsCoreAbi | typeof factoryAbi, name: string) {
  return receipt.logs
    .map((log) => {
      try {
        return decodeEventLog({ abi, data: log.data, topics: log.topics });
      } catch {
        return null;
      }
    })
    .find((decoded) => decoded?.eventName === name);
}

async function setReactivityGasParams(creator: Address): Promise<Hex> {
  const hash = await walletClient.writeContract({
    address: creator,
    abi: creatorAbi,
    functionName: "setReactivityGasParams",
    args: [REACTIVITY.priorityFeePerGas, REACTIVITY.maxFeePerGas, REACTIVITY.gasLimit],
    gas: 10_000_000n,
  });
  await wait(hash);
  return hash;
}

async function validateConfiguredCreator(address: Address): Promise<boolean> {
  const [owner, core, operatorId, venueId, series, marketCount, priorityFeePerGas, maxFeePerGas, gasLimit] = await Promise.all([
    publicClient.readContract({ address, abi: creatorAbi, functionName: "owner" }),
    publicClient.readContract({ address, abi: creatorAbi, functionName: "core" }),
    publicClient.readContract({ address, abi: creatorAbi, functionName: "operatorId" }),
    publicClient.readContract({ address, abi: creatorAbi, functionName: "venueId" }),
    publicClient.readContract({ address, abi: creatorAbi, functionName: "seriesById", args: [SERIES_ID] }),
    publicClient.readContract({ address, abi: creatorAbi, functionName: "marketCount" }),
    publicClient.readContract({ address, abi: creatorAbi, functionName: "reactivityPriorityFeePerGas" }),
    publicClient.readContract({ address, abi: creatorAbi, functionName: "reactivityMaxFeePerGas" }),
    publicClient.readContract({ address, abi: creatorAbi, functionName: "reactivityGasLimit" }),
  ]);
  const valid = owner.toLowerCase() === account.address.toLowerCase()
    && core.toLowerCase() === SOMNIA_TESTNET_ADDRESSES.binaryModule!.toLowerCase()
    && Number(operatorId) > 0
    && venueId !== `0x${"00".repeat(32)}`
    && series[0].toLowerCase() === SOMNIA_TESTNET_ADDRESSES.collateral!.toLowerCase()
    && series[1] === SERIES.asset
    && series[2] === SERIES.numericDecimals
    && series[3] === SERIES.intervalSec
    && series[4] === SERIES.settlementWindow;
  if (!valid) return false;
  if (priorityFeePerGas !== REACTIVITY.priorityFeePerGas || maxFeePerGas !== REACTIVITY.maxFeePerGas || gasLimit !== REACTIVITY.gasLimit) {
    await setReactivityGasParams(address);
  }
  const balance = await publicClient.getBalance({ address });
  if (balance < CREATOR_MIN_BALANCE) {
    const hash = await walletClient.sendTransaction({ to: address, value: CREATOR_MIN_BALANCE - balance, gas: 100_000n });
    await wait(hash);
  }
  if (marketCount === 0n) {
    const hash = await walletClient.writeContract({ address, abi: creatorAbi, functionName: "triggerRoll", args: [SERIES_ID], gas: 100_000_000n });
    await wait(hash);
  }
  return true;
}

async function main() {
  const configured = process.env.DREAMDEX_MARKET_CREATOR_ADDRESS?.trim();
  if (configured && await validateConfiguredCreator(configured as Address)) {
    console.log(JSON.stringify({ creator: configured, seriesId: SERIES_ID, status: "already-configured" }));
    return;
  }

  const balance = await publicClient.getBalance({ address: account.address });
  if (balance < 34n * 10n ** 18n) throw new Error("CREATOR_ADDRESS needs at least 34 STT before provisioning");

  const operatorHash = await walletClient.writeContract({
    address: SOMNIA_TESTNET_ADDRESSES.marketsCore!,
    abi: marketsCoreAbi,
    functionName: "registerOperator",
    args: [account.address, true, ZERO, "0x"],
    gas: 10_000_000n,
  });
  const operatorReceipt = await wait(operatorHash);
  const operatorEvent = decodedEvent(operatorReceipt, marketsCoreAbi, "OperatorRegistered");
  const operatorId = Number((operatorEvent?.args as { operatorId?: number | bigint } | undefined)?.operatorId);
  if (!Number.isInteger(operatorId) || operatorId <= 0) throw new Error("OperatorRegistered event was not found");

  const venueHash = await walletClient.writeContract({
    address: SOMNIA_TESTNET_ADDRESSES.marketsCore!,
    abi: marketsCoreAbi,
    functionName: "createVenue",
    args: [operatorId, MARKET_TYPE_BINARY_V1, {
      feeParams,
      feeRecipientOverride: ZERO,
      // The deployed policy is a protocol allowlist; a user-owned operator
      // must use the zero policy for autonomous rolling.
      policy: ZERO,
      signer: ZERO,
      creationEnabled: true,
      context: "0x",
    }],
    gas: 10_000_000n,
  });
  const venueReceipt = await wait(venueHash);
  const venueEvent = decodedEvent(venueReceipt, marketsCoreAbi, "VenueCreated");
  const venueId = (venueEvent?.args as { venueId?: Hex } | undefined)?.venueId;
  if (!venueId) throw new Error("VenueCreated event was not found");

  const createHash = await walletClient.writeContract({
    address: SOMNIA_TESTNET_ADDRESSES.marketCreatorFactory!,
    abi: factoryAbi,
    functionName: "createMarketCreator",
    args: [account.address, SOMNIA_TESTNET_ADDRESSES.binaryModule!, SOMNIA_TESTNET_ADDRESSES.oracleHub!, operatorId, venueId, bookParams],
    gas: 100_000_000n,
  });
  const createReceipt = await wait(createHash);
  const creatorEvent = decodedEvent(createReceipt, factoryAbi, "MarketCreatorCreated");
  const creator = (creatorEvent?.args as { creator?: Address } | undefined)?.creator;
  if (!creator) throw new Error("MarketCreatorCreated event was not found");

  const seriesHash = await walletClient.writeContract({
    address: creator,
    abi: creatorAbi,
    functionName: "registerSeries",
    args: [SERIES_ID, {
      collateral: SOMNIA_TESTNET_ADDRESSES.collateral!,
      asset: SERIES.asset,
      numericDecimals: SERIES.numericDecimals,
      intervalSec: SERIES.intervalSec,
      settlementWindow: SERIES.settlementWindow,
    }],
    gas: 10_000_000n,
  });
  await wait(seriesHash);

  const paramsHash = await setReactivityGasParams(creator);
  const fundHash = await walletClient.sendTransaction({ to: creator, value: CREATOR_MIN_BALANCE, gas: 100_000n });
  await wait(fundHash);
  const rollHash = await walletClient.writeContract({ address: creator, abi: creatorAbi, functionName: "triggerRoll", args: [SERIES_ID], gas: 100_000_000n });
  await wait(rollHash);

  console.log(JSON.stringify({ operatorId, venueId, creator, seriesId: SERIES_ID, operatorHash, venueHash, createHash, seriesHash, paramsHash, fundHash, rollHash, status: "ready" }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
