/**
 * DreamDEX Event Contracts — the prediction-market execution layer Mimir now
 * settles through on Somnia (Shannon testnet).
 *
 * Mimir keeps its AI/oracle, council, market-creator and UX surfaces; the
 * on-chain order books, complete-set mint/merge and redemption are owned by the
 * Somnia Markets contracts via @somnia-chain/markets-sdk. There is no
 * self-hosted claim contract anymore — markets are the SDK's live binary markets
 * and settlement is the protocol's own oracle-driven rail.
 */
import {
  SomniaMarkets,
  SOMNIA_TESTNET_ADDRESSES,
  SOMNIA_MAINNET_ADDRESSES,
  isBinaryMarket,
  type SomniaMarketsConfig,
  type Market,
  type UnifiedMarket,
} from "@somnia-chain/markets-sdk";
import { somniaShannon, somniaMainnet } from "@somnia-chain/markets-sdk/chains";
import {
  CHAIN,
  SOMNIA_CAIP2,
  getSomniaRpcUrl,
  getSomniaWsUrl,
  getDreamdexIndexerUrl,
} from "./somnia";

export { somniaShannon, somniaMainnet, isBinaryMarket };
export type { Market };

export const DREAMDEX_NETWORK = SOMNIA_CAIP2;

/** Widen the literal chain id so mainnet/work comparisons type-check. */
const CHAIN_ID: number = CHAIN.id;
export const IS_MAINNET = CHAIN_ID === 5031;

/** Protocol core addresses for the active network (CREATE3 → same on both). */
export const DREAMDEX_ADDRESSES = IS_MAINNET ? SOMNIA_MAINNET_ADDRESSES : SOMNIA_TESTNET_ADDRESSES;

/** The per-venue collateral (faucet USDC on testnet, USDso on mainnet). */
export const COLLATERAL = DREAMDEX_ADDRESSES.collateral;

function envHex(name: string): `0x${string}` | undefined {
  const raw = process.env[name]?.trim();
  return raw && /^0x[0-9a-fA-F]{40}$/.test(raw) ? (raw as `0x${string}`) : undefined;
}

/**
 * Build the SomniaMarkets config: the SDK's baked-in protocol addresses, an
 * explicit token-collateral override for a local fork, the DreamDEX indexer and
 * a Somnia WebSocket for the live tail. One instance per process/worker.
 */
export function somniaMarketsConfig(opts?: {
  privateKey?: `0x${string}`;
  account?: `0x${string}`;
}): SomniaMarketsConfig {
  const collateral = envHex("NEXT_PUBLIC_COLLATERAL_ADDRESS") ?? envHex("COLLATERAL_ADDRESS");
  return {
    indexerUrl: getDreamdexIndexerUrl(),
    chain: CHAIN,
    wsRpcUrl: getSomniaWsUrl(),
    addresses: {
      ...DREAMDEX_ADDRESSES,
      ...(collateral ? { collateral } : {}),
    },
    ...(opts?.privateKey ? { privateKey: opts.privateKey } : {}),
    ...(opts?.account ? { account: opts.account } : {}),
  };
}

/** A ready-to-use exchange for the active Somnia network (authenticated when a key is given). */
export function createExchange(opts?: {
  privateKey?: `0x${string}`;
  account?: `0x${string}`;
}): SomniaMarkets {
  return new SomniaMarkets(somniaMarketsConfig(opts));
}

/**
 * Every write is quantized to the venue's tick/lot grids before it is signed —
 * a bare float (e.g. an Up price) can be a few wei off-grid and the pool rejects
 * it with InvalidPrice. `ONE` is 1 collateral unit on the market (USDso atomic
 * on mainnet, faucet USDC atomic on testnet), so the grid scales with the
 * venue's decimals: 6 on testnet, 18 on mainnet.
 */
export const COLLATERAL_DECIMALS = IS_MAINNET ? 18 : 6;
export const ONE = 10n ** BigInt(COLLATERAL_DECIMALS);
export const TICK = 1_000_000_000n;   // 1e-9 of ONE
export const LOT = ONE / 100_000_000n; // 1e-8 of a complete set

/** Snap an Up price in (0,1) to a whole number of ticks. */
export function toTickPrice(price: number): bigint {
  const ticks = Math.round((price * Number(ONE)) / Number(TICK));
  return BigInt(ticks) * TICK;
}

/** Floor a quantity to the venue's lot grid; returns 0n when it would floor to nothing. */
export function toLotSize(quantity: number): bigint {
  const lots = Math.floor((quantity * Number(ONE)) / Number(LOT) + 1e-9);
  return lots > 0 ? BigInt(lots) * LOT : 0n;
}

/** Format collateral atomic units using the venue's decimals. */
export function formatCollateral(units: bigint, maxFractionDigits = COLLATERAL_DECIMALS): string {
  const sign = units < 0n ? "-" : "";
  const absolute = units < 0n ? -units : units;
  const whole = absolute / ONE;
  const fraction = (absolute % ONE).toString().padStart(COLLATERAL_DECIMALS, "0")
    .slice(0, Math.max(0, Math.min(COLLATERAL_DECIMALS, maxFractionDigits))).replace(/0+$/, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** Parse a decimal collateral string into atomic units (strict, venue-decimals). */
export function parseCollateralUnits(input: string | number): bigint {
  const value = String(input).trim();
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error("Invalid collateral amount");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > COLLATERAL_DECIMALS) throw new Error(`Max ${COLLATERAL_DECIMALS} decimals`);
  return BigInt(whole) * ONE + BigInt(fraction.padEnd(COLLATERAL_DECIMALS, "0"));
}

/** Up-outcome symbol for a binary market (prices are Up probabilities in (0,1)). */
export function upSymbolOf(market: UnifiedMarket): string | null {
  return market.outcomes?.[0]?.symbol ?? null;
}

/** A readable collision-free id for tracking: marketId wins, symbol is the fallback. */
export function marketKey(raw: string | `0x${string}`): string {
  return raw.startsWith("0x") ? raw : raw.toLowerCase();
}

/** Always gate a write on the live on-chain status (the indexer lags by seconds). */
export const MARKET_STATUS = {
  LISTED: 0,
  TRADING: 1,
  LOCKED: 2,
  RESOLVED: 4,
  VOIDED: 5,
} as const;
