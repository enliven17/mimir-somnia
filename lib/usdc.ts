/**
 * Somnia testnet collateral (ERC-20, 6 decimals) — the single Mimir asset.
 *
 * Market stakes, payouts, agent bankrolls and x402 payments are all denominated
 * in this token. Gas remains native STT.
 *
 * Official address list:
 * https://developers.circle.com/stablecoins/usdc-contract-addresses
 */
import { parseAbi } from "viem";
import { DREAMDEX_ADDRESSES } from "./dreamdex";

/** Circle's official Somnia Shannon testnet USDC. */
export const USDC_ADDRESS =
  (process.env.NEXT_PUBLIC_COLLATERAL_ADDRESS?.trim() as `0x${string}` | undefined) ||
  DREAMDEX_ADDRESSES.collateral;

export const USDC_DECIMALS = 6;
export const USDC_SYMBOL = "USDC";

/** 1 USDC in atomic units. */
export const USDC_UNIT = 1_000_000n;

/** Strict 6-decimal parser. Financial boundaries should pass the user's raw string. */
export function parseUsdcAtomic(input: string | number): bigint {
  const value = String(input).trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) throw new Error("Invalid USDC amount");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * USDC_UNIT + BigInt(fraction.padEnd(USDC_DECIMALS, "0"));
}

/** Exact decimal rendering for logs/API/UI; never passes through IEEE-754. */
export function formatAtomicUsdc(units: bigint | string, maxFractionDigits = USDC_DECIMALS): string {
  const value = typeof units === "bigint" ? units : BigInt(units);
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const whole = absolute / USDC_UNIT;
  const fraction = (absolute % USDC_UNIT).toString().padStart(USDC_DECIMALS, "0")
    .slice(0, Math.max(0, Math.min(USDC_DECIMALS, maxFractionDigits))).replace(/0+$/, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** Minimum stake in display USDC — matches Mimir.sol MIN_STAKE = 2 * 10^6 */
export const MIN_STAKE_USDC = 2;

export const ERC20_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
]);

/**
 * Convert display USDC to atomic units (6 decimals).
 * Supports up to 6 fractional digits.
 */
export function usdcToUnits(usdc: number): bigint {
  if (!Number.isFinite(usdc) || usdc < 0) throw new Error("Invalid USDC amount");
  return parseUsdcAtomic(usdc);
}

/** Convert atomic units to display USDC. */
export function unitsToUsdc(units: bigint | number): number {
  return Number(BigInt(units)) / 1_000_000;
}

export function formatUsdcAmount(units: bigint | number, decimals = 2): string {
  return unitsToUsdc(units).toFixed(decimals) + " USDC";
}
