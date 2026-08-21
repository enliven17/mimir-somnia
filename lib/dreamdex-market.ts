/**
 * Canonical DreamDEX market service.
 *
 * The rest of the application should deal in these small, JSON-safe DTOs
 * instead of reaching into the SDK's indexed union or reimplementing market
 * lookup. The market id is the stable identity; pool addresses are only
 * execution details because a pool can be recycled.
 */
import {
  createExchange,
  type Market,
} from "./dreamdex";
import type {
  UnifiedBalances,
  UnifiedMarket,
  UnifiedOrder,
  UnifiedOrderBook,
  UnifiedTrade,
} from "@somnia-chain/markets-sdk";
import {
  isBinaryMarket,
  priceToProbability,
  toHuman,
  type BinaryMarket,
} from "@somnia-chain/markets-sdk";
import type { Address, Hex } from "viem";

export type DreamDexStatus = BinaryMarket["status"];

export type DreamDexMarket = {
  id: string;
  marketId: Hex;
  marketAddress: Address;
  poolAddress: Address;
  symbol: string;
  asset: string;
  question: string;
  oracleQuestion: string | null;
  status: DreamDexStatus;
  active: boolean;
  tradingStart: number;
  expiry: number;
  yesSymbol: string;
  noSymbol: string;
  yesTokenId: string;
  noTokenId: string;
  winningOutcome: number | null;
  voided: boolean;
  resolvedAt: number | null;
  lastPrice: number | null;
  volume: number;
  tradeCount: number;
  createdAt: number;
  raw: {
    collateral: Address;
    oracleQuestionId: string | null;
    strike: string;
    payoutNumerators: string[] | null;
    payoutDenominator: string | null;
    backing: string;
    nonce: string | null;
  };
};

export type DreamDexOrder = {
  id: string;
  market: string;
  outcome: "YES" | "NO" | null;
  type: UnifiedOrder["type"];
  side: UnifiedOrder["side"];
  price: number | null;
  amount: number;
  filled: number;
  remaining: number;
  status: UnifiedOrder["status"];
  txHash: Hex | null;
  timestamp: number | null;
};

export type DreamDexTrade = {
  id: string;
  market: string;
  outcome: "YES" | "NO" | null;
  price: number;
  amount: number;
  cost: number;
  side: UnifiedTrade["side"] | null;
  txHash: Hex | null;
  timestamp: number;
};

export type DreamDexBalance = {
  code: string;
  free: number;
  used: number;
  total: number;
  outcome: "YES" | "NO" | null;
};

export type DreamDexOrderBook = {
  symbol: string;
  outcome: "YES" | "NO";
  bids: [number, number][];
  asks: [number, number][];
  timestamp: number | null;
};

export type DreamDexPortfolio = {
  address: Address;
  balances: DreamDexBalance[];
  openOrders: DreamDexOrder[];
  orders: DreamDexOrder[];
  trades: DreamDexTrade[];
};

type BinaryUnifiedMarket = UnifiedMarket & { info: BinaryMarket };

function numberOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function unixSeconds(value: string | null | undefined): number | null {
  const parsed = numberOrNull(value);
  return parsed === null ? null : Math.round(parsed);
}

function outcomeFromSymbol(symbol: string): "YES" | "NO" | null {
  const suffix = symbol.split("#").at(-1)?.toUpperCase();
  return suffix === "YES" || suffix === "NO" ? suffix : null;
}

function asHex(value: string | null | undefined): Hex | null {
  return value && /^0x[0-9a-fA-F]+$/.test(value) ? (value as Hex) : null;
}

function asBinaryMarket(market: UnifiedMarket): BinaryUnifiedMarket | null {
  return market.type === "binary" && isBinaryMarket(market.info)
    ? (market as BinaryUnifiedMarket)
    : null;
}

export function toDreamDexMarket(market: UnifiedMarket): DreamDexMarket | null {
  const binary = asBinaryMarket(market);
  if (!binary) return null;

  const info = binary.info;
  const yesSymbol = binary.outcomes?.find((outcome) => outcome.label.toUpperCase() === "YES")?.symbol
    ?? `${binary.symbol}#YES`;
  const noSymbol = binary.outcomes?.find((outcome) => outcome.label.toUpperCase() === "NO")?.symbol
    ?? `${binary.symbol}#NO`;

  return {
    id: info.marketId,
    marketId: info.marketId,
    marketAddress: info.marketAddress,
    poolAddress: info.poolAddress,
    symbol: binary.symbol,
    asset: info.asset,
    question: info.question,
    oracleQuestion: info.oracleQuestion,
    status: info.status,
    active: binary.active,
    tradingStart: unixSeconds(info.tradingStart) ?? 0,
    expiry: unixSeconds(info.expiry) ?? 0,
    yesSymbol,
    noSymbol,
    yesTokenId: info.yesTokenId,
    noTokenId: info.noTokenId,
    winningOutcome: info.winningOutcome,
    voided: info.voided,
    resolvedAt: unixSeconds(info.resolvedAtTimestamp),
    lastPrice: info.lastPrice === null
      ? null
      : priceToProbability(info.lastPrice, info.quoteDecimals),
    volume: toHuman(info.cumulativeQuoteVolume, info.quoteDecimals),
    tradeCount: numberOrNull(info.tradeCount) ?? 0,
    createdAt: unixSeconds(info.createdAtTimestamp) ?? 0,
    raw: {
      collateral: info.collateral,
      oracleQuestionId: info.oracleQuestionId ?? null,
      strike: info.strike,
      payoutNumerators: info.payoutNumerators ?? null,
      payoutDenominator: info.payoutDenominator ?? null,
      backing: info.backing,
      nonce: info.nonce ?? null,
    },
  };
}

function toOrder(order: UnifiedOrder): DreamDexOrder {
  return {
    id: order.id,
    market: order.symbol.split("#")[0] ?? order.symbol,
    outcome: outcomeFromSymbol(order.symbol),
    type: order.type,
    side: order.side,
    price: order.price ?? null,
    amount: order.amount,
    filled: order.filled,
    remaining: order.remaining,
    status: order.status,
    txHash: asHex(order.txHash),
    timestamp: order.timestamp ?? null,
  };
}

function toTrade(trade: UnifiedTrade): DreamDexTrade {
  return {
    id: trade.id,
    market: trade.symbol.split("#")[0] ?? trade.symbol,
    outcome: outcomeFromSymbol(trade.symbol),
    price: trade.price,
    amount: trade.amount,
    cost: trade.cost,
    side: trade.side ?? null,
    txHash: asHex(trade.txHash),
    timestamp: trade.timestamp,
  };
}

function toBalance(code: string, balance: UnifiedBalances[string]): DreamDexBalance {
  return {
    code,
    free: balance.free,
    used: balance.used,
    total: balance.total,
    outcome: outcomeFromSymbol(code),
  };
}

let readExchange: ReturnType<typeof createExchange> | null = null;
let marketLoad: Promise<Record<string, UnifiedMarket>> | null = null;

function getReadExchange() {
  return (readExchange ??= createExchange());
}

export async function loadDreamDexMarkets(options?: {
  reload?: boolean;
  includeInactive?: boolean;
}): Promise<DreamDexMarket[]> {
  const exchange = getReadExchange();
  if (options?.reload) marketLoad = null;
  const markets = await (marketLoad ??= exchange.loadMarkets());
  return Object.values(markets)
    .map(toDreamDexMarket)
    .filter((market): market is DreamDexMarket => Boolean(market))
    .filter((market) => options?.includeInactive || market.active);
}

export async function getDreamDexMarket(ref: string): Promise<{
  exchange: ReturnType<typeof createExchange>;
  market: DreamDexMarket;
  unified: BinaryUnifiedMarket;
}> {
  const exchange = getReadExchange();
  const markets = await (marketLoad ??= exchange.loadMarkets());
  const match = Object.values(markets)
    .map((market) => ({ unified: asBinaryMarket(market), market: toDreamDexMarket(market) }))
    .find(({ unified, market }) => {
      if (!unified || !market) return false;
      const normalized = ref.toLowerCase();
      return [market.id, market.symbol, market.marketAddress, market.poolAddress]
        .some((candidate) => candidate.toLowerCase() === normalized);
    });

  if (!match?.unified || !match.market) throw new Error("DreamDEX market not found");
  return { exchange, market: match.market, unified: match.unified };
}

export async function getDreamDexOrderBook(
  ref: string,
  outcome: "YES" | "NO" = "YES",
  limit = 50,
): Promise<DreamDexOrderBook> {
  const { exchange, market, unified } = await getDreamDexMarket(ref);
  const symbol = outcome === "YES" ? market.yesSymbol : market.noSymbol;
  const book: UnifiedOrderBook = await exchange.fetchOrderBook(symbol, limit);
  return {
    symbol,
    outcome,
    bids: book.bids,
    asks: book.asks,
    timestamp: book.timestamp ?? null,
  };
}

function accountExchange(address: Address) {
  return createExchange({ account: address });
}

export async function getDreamDexPortfolio(address: Address): Promise<DreamDexPortfolio> {
  const exchange = accountExchange(address);
  try {
    await exchange.loadMarkets();
    const [balances, openOrders, orders, trades] = await Promise.all([
      exchange.fetchBalance(),
      exchange.fetchOpenOrders(),
      exchange.fetchOrders(undefined, undefined, 100),
      exchange.fetchMyTrades(undefined, undefined, 100),
    ]);
    return {
      address,
      balances: Object.entries(balances).map(([code, balance]) => toBalance(code, balance)),
      openOrders: openOrders.map(toOrder),
      orders: orders.map(toOrder),
      trades: trades.map(toTrade),
    };
  } finally {
    await exchange.close().catch(() => undefined);
  }
}

function signerKey(key: string | undefined): `0x${string}` | null {
  return key && /^0x[0-9a-fA-F]{64}$/.test(key) ? (key as `0x${string}`) : null;
}

export function getDreamDexAgentKey(kind: "oracle" | "creator" | "trader"): `0x${string}` | null {
  const names = kind === "oracle"
    ? ["ORACLE_PRIVATE_KEY"]
    : kind === "creator"
      ? ["CREATOR_PRIVATE_KEY", "MARKET_CREATOR_PRIVATE_KEY"]
      : ["TRADER_PRIVATE_KEY"];
  for (const name of names) {
    const key = signerKey(process.env[name]);
    if (key) return key;
  }
  return null;
}

export async function withDreamDexSigner<T>(
  privateKey: `0x${string}`,
  task: (exchange: ReturnType<typeof createExchange>) => Promise<T>,
): Promise<T> {
  const exchange = createExchange({ privateKey });
  try {
    await exchange.loadMarkets();
    return await task(exchange);
  } finally {
    await exchange.close().catch(() => undefined);
  }
}

export async function placeDreamDexOrder(args: {
  privateKey: `0x${string}`;
  market: string;
  outcome: "YES" | "NO";
  type: "limit" | "market";
  side: "buy" | "sell";
  amount: number;
  price?: number;
}) {
  return withDreamDexSigner(args.privateKey, async (exchange) => {
    const { market } = await getDreamDexMarket(args.market);
    const symbol = args.outcome === "YES" ? market.yesSymbol : market.noSymbol;
    const order = await exchange.createOrder(symbol, args.type, args.side, args.amount, args.price);
    return toOrder(order);
  });
}

export async function cancelDreamDexOrder(args: {
  privateKey: `0x${string}`;
  market: string;
  orderId: string;
}) {
  return withDreamDexSigner(args.privateKey, async (exchange) => {
    const { market } = await getDreamDexMarket(args.market);
    const result = await exchange.cancelOrder(args.orderId, market.yesSymbol);
    return { id: result.id, market: market.id, status: result.status } as const;
  });
}

export async function mintDreamDexSet(args: { privateKey: `0x${string}`; market: string; amount: number }) {
  return withDreamDexSigner(args.privateKey, async (exchange) => {
    const { market } = await getDreamDexMarket(args.market);
    return exchange.mintSet(market.symbol, args.amount);
  });
}

export async function burnDreamDexSet(args: { privateKey: `0x${string}`; market: string; amount: number }) {
  return withDreamDexSigner(args.privateKey, async (exchange) => {
    const { market } = await getDreamDexMarket(args.market);
    return exchange.burnSet(market.symbol, args.amount);
  });
}

export async function redeemDreamDex(args: { privateKey: `0x${string}`; market: string; amount: number }) {
  return withDreamDexSigner(args.privateKey, async (exchange) => {
    const { market } = await getDreamDexMarket(args.market);
    return exchange.redeem(market.symbol, args.amount);
  });
}

export function isDreamDexMarket(value: Market | UnifiedMarket): value is BinaryMarket {
  return "marketType" in value && isBinaryMarket(value as Market);
}
