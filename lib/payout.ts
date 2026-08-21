/**
 * Payout math, in USDC atomic units — the single source shared by the stake
 * preview, the explorer cards and the tests.
 *
 * Every function here mirrors `Mimir.sol` **exactly**, including integer
 * truncation. The UI used to preview pool payouts with floating-point division,
 * which drifts from the contract by up to a dust unit per challenger and can
 * promise a number the settlement will not pay. Preview in atomic integers,
 * convert to decimals only for display.
 *
 * Vocabulary is deliberate and must not be collapsed in the UI:
 *   totalReturn      what lands in the wallet on a win (principal + profit)
 *   returnedPrincipal the stake coming back
 *   netProfit        totalReturn - returnedPrincipal
 * "2x" always means 2x TOTAL RETURN, never 2x profit.
 */

import { unitsToUsdc, usdcToUnits } from "./usdc";

export const BPS_DIVISOR_UNITS = 10_000n;

export interface PayoutBreakdown {
  /** Everything the winner receives, atomic units. */
  totalReturnUnits: bigint;
  /** The winner's own stake, returned. */
  returnedPrincipalUnits: bigint;
  /** Winnings on top of the principal. */
  netProfitUnits: bigint;
}

function breakdown(totalReturnUnits: bigint, stakeUnits: bigint): PayoutBreakdown {
  const returned = totalReturnUnits < stakeUnits ? totalReturnUnits : stakeUnits;
  return {
    totalReturnUnits,
    returnedPrincipalUnits: returned,
    netProfitUnits: totalReturnUnits - returned,
  };
}

/**
 * A pool challenger's payout, mirroring Mimir.sol:
 *
 *   share  = (chStake * creatorStake) / totalChallengerStake   // integer floor
 *   payout = chStake + share
 *
 * `challengerPoolUnits` must be the pool AFTER this stake joins — that is what
 * the contract divides by at settlement, so previewing against the pre-join pool
 * overstates the payout.
 */
export function poolChallengerPayoutUnits(args: {
  stakeUnits: bigint;
  creatorStakeUnits: bigint;
  challengerPoolUnits: bigint;
}): PayoutBreakdown {
  const { stakeUnits, creatorStakeUnits, challengerPoolUnits } = args;
  if (stakeUnits <= 0n) return breakdown(0n, 0n);
  if (challengerPoolUnits <= 0n) return breakdown(stakeUnits, stakeUnits);
  const share = (stakeUnits * creatorStakeUnits) / challengerPoolUnits;
  return breakdown(stakeUnits + share, stakeUnits);
}

/** Pool creator's payout on a win: the whole pot. */
export function poolCreatorPayoutUnits(args: {
  creatorStakeUnits: bigint;
  challengerPoolUnits: bigint;
}): PayoutBreakdown {
  const total = args.creatorStakeUnits + args.challengerPoolUnits;
  return breakdown(total, args.creatorStakeUnits);
}

/**
 * Fixed-odds challenger payout, mirroring Mimir.sol `_grossPayout`:
 *   (stake * bps) / 10_000
 * bps is a TOTAL RETURN multiple: 20_000 = 2x total return = 1x profit.
 */
export function fixedOddsPayoutUnits(args: {
  stakeUnits: bigint;
  challengerPayoutBps: number;
}): PayoutBreakdown {
  const bps = BigInt(Math.max(0, Math.trunc(args.challengerPayoutBps)));
  if (args.stakeUnits <= 0n || bps <= 0n) return breakdown(0n, 0n);
  return breakdown((args.stakeUnits * bps) / BPS_DIVISOR_UNITS, args.stakeUnits);
}

/**
 * How much challenger stake a fixed-odds market can absorb.
 *
 * Inverse of the liability calculation: the creator backs the challenger's PROFIT,
 * so capacity is stake / (multiple - 1). At 2x a 10 USDC creator can take 10 USDC
 * of challenges; at 3x only 5. Worth stating because raising the promised multiple
 * silently shrinks the market.
 *
 * A multiple at or below 1x returns 0 rather than dividing by zero — such a market
 * is rejected by validateMode anyway, and an infinite capacity would render as a
 * market that can absorb anything.
 */
export function fixedOddsCapacityUnits(args: {
  creatorStakeUnits: bigint;
  challengerPayoutBps: number;
}): bigint {
  const bps = BigInt(Math.max(0, Math.trunc(args.challengerPayoutBps)));
  if (bps <= BPS_DIVISOR_UNITS || args.creatorStakeUnits <= 0n) return 0n;
  // Integer division floors, so capacity never promises a unit the creator cannot
  // cover — the rounding always favours the escrow.
  return (args.creatorStakeUnits * BPS_DIVISOR_UNITS) / (bps - BPS_DIVISOR_UNITS);
}

/**
 * Creator liability a fixed-odds challenge reserves — the challenger's PROFIT,
 * not the gross payout. Mirrors the contract's reservedCreatorLiability update.
 */
export function fixedOddsReservedLiabilityUnits(args: {
  stakeUnits: bigint;
  challengerPayoutBps: number;
}): bigint {
  return fixedOddsPayoutUnits(args).netProfitUnits;
}

/** Unreserved creator liquidity still available to back new fixed-odds stakes. */
export function availableCreatorLiquidityUnits(args: {
  creatorStakeUnits: bigint;
  reservedLiabilityUnits: bigint;
}): bigint {
  const available = args.creatorStakeUnits - args.reservedLiabilityUnits;
  return available > 0n ? available : 0n;
}

/** Largest stake this fixed-odds market can still accept. */
export function maxFixedOddsStakeUnits(args: {
  availableLiquidityUnits: bigint;
  challengerPayoutBps: number;
}): bigint {
  const bps = BigInt(Math.max(0, Math.trunc(args.challengerPayoutBps)));
  if (bps <= BPS_DIVISOR_UNITS) return 0n;
  // profit = stake * (bps - 10000) / 10000 <= available
  return (args.availableLiquidityUnits * BPS_DIVISOR_UNITS) / (bps - BPS_DIVISOR_UNITS);
}

// ── Pool shape / discovery ────────────────────────────────────────────────────

export type PoolSide = "creator" | "challengers";

export interface PoolBalance {
  creatorStakeUnits: bigint;
  challengerPoolUnits: bigint;
  totalPotUnits: bigint;
  /** Creator share of the pot in basis points; 5000 = balanced. */
  creatorShareBps: number;
  /** The side holding less money — the one with payout upside. Null when even. */
  minoritySide: PoolSide | null;
  crowdedSide: PoolSide | null;
  /** |creatorShare - 50%| in bps. 0 = perfectly balanced, 5000 = one-sided. */
  imbalanceBps: number;
}

export function poolBalance(args: {
  creatorStakeUnits: bigint;
  challengerPoolUnits: bigint;
}): PoolBalance {
  const { creatorStakeUnits, challengerPoolUnits } = args;
  const totalPotUnits = creatorStakeUnits + challengerPoolUnits;
  if (totalPotUnits <= 0n) {
    return {
      creatorStakeUnits,
      challengerPoolUnits,
      totalPotUnits,
      creatorShareBps: 5_000,
      minoritySide: null,
      crowdedSide: null,
      imbalanceBps: 0,
    };
  }
  const creatorShareBps = Number((creatorStakeUnits * BPS_DIVISOR_UNITS) / totalPotUnits);
  const even = creatorStakeUnits === challengerPoolUnits;
  const creatorIsMinority = creatorStakeUnits < challengerPoolUnits;
  return {
    creatorStakeUnits,
    challengerPoolUnits,
    totalPotUnits,
    creatorShareBps,
    minoritySide: even ? null : creatorIsMinority ? "creator" : "challengers",
    crowdedSide: even ? null : creatorIsMinority ? "challengers" : "creator",
    imbalanceBps: Math.abs(creatorShareBps - 5_000),
  };
}

/**
 * Net profit as a fraction of stake, in bps. 10_000 = doubling your money.
 * This is payout asymmetry only — never a claim about the chance of winning.
 */
export function upsideBps(payout: PayoutBreakdown): number {
  if (payout.returnedPrincipalUnits <= 0n) return 0;
  return Number((payout.netProfitUnits * BPS_DIVISOR_UNITS) / payout.returnedPrincipalUnits);
}

/**
 * Below this, joining is mostly principal risk for little upside — the crowded
 * side of a lopsided pool. 2000 bps = you risk your stake to win 20% of it.
 */
export const LOW_UPSIDE_BPS = 2_000;

export function isLowUpside(payout: PayoutBreakdown): boolean {
  return payout.netProfitUnits > 0n && upsideBps(payout) < LOW_UPSIDE_BPS;
}

// ── Display helpers ───────────────────────────────────────────────────────────

export interface PayoutDisplay {
  totalReturn: number;
  returnedPrincipal: number;
  netProfit: number;
  /** Total-return multiple, e.g. 2 for 2x. 0 when there is no stake. */
  totalReturnMultiple: number;
  upsideBps: number;
  isLowUpside: boolean;
}

export function toPayoutDisplay(payout: PayoutBreakdown): PayoutDisplay {
  const returnedPrincipal = unitsToUsdc(payout.returnedPrincipalUnits);
  return {
    totalReturn: unitsToUsdc(payout.totalReturnUnits),
    returnedPrincipal,
    netProfit: unitsToUsdc(payout.netProfitUnits),
    totalReturnMultiple:
      payout.returnedPrincipalUnits > 0n
        ? unitsToUsdc(payout.totalReturnUnits) / returnedPrincipal
        : 0,
    upsideBps: upsideBps(payout),
    isLowUpside: isLowUpside(payout),
  };
}

/**
 * Preview a challenger's payout from display-USDC inputs. Converts to atomic
 * units first so the preview matches settlement to the unit.
 */
export function previewChallengerPayout(args: {
  settlementMode: "pool" | "duel" | "fixed_odds" | "squad_pool";
  /** The stake being previewed, display USDC. */
  stake: number;
  creatorStake: number;
  /** Challenger pool BEFORE this stake joins, display USDC. */
  challengerPoolBefore: number;
  challengerPayoutBps?: number;
}): PayoutDisplay {
  const stakeUnits = usdcToUnits(args.stake);
  const creatorStakeUnits = usdcToUnits(args.creatorStake);

  if (args.settlementMode === "fixed_odds") {
    return toPayoutDisplay(
      fixedOddsPayoutUnits({ stakeUnits, challengerPayoutBps: args.challengerPayoutBps ?? 0 }),
    );
  }
  if (args.settlementMode === "duel") {
    // Winner takes the two-person pot; stakes are equal by policy.
    return toPayoutDisplay(breakdown(stakeUnits + creatorStakeUnits, stakeUnits));
  }
  return toPayoutDisplay(
    poolChallengerPayoutUnits({
      stakeUnits,
      creatorStakeUnits,
      challengerPoolUnits: usdcToUnits(args.challengerPoolBefore) + stakeUnits,
    }),
  );
}
