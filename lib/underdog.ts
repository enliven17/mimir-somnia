/**
 * Underdog discovery.
 *
 * An "underdog" here is a **payout asymmetry**, nothing more. The minority side of
 * a lopsided pool pays more because it wins less money from more people — that is
 * arithmetic, not a forecast. Every label this module produces is worded so it
 * cannot be read as "this side is more likely to win", because it isn't.
 *
 * The signal is derived from pool shape at read time, which is why underdog is a
 * discovery modifier rather than something a market is created as: a market has no
 * underdog side until money has arrived.
 */

import type { VSData } from "./contract";
import { poolBalance, upsideBps, poolChallengerPayoutUnits } from "./payout";
import { usdcToUnits } from "./usdc";
import { toCanonicalMode } from "./market-modes";

/**
 * Minimum imbalance before a market is called an underdog opportunity. Below
 * this the asymmetry is noise and the badge would be meaningless.
 * 1500 bps = one side holds 65% of the pot.
 */
export const UNDERDOG_MIN_IMBALANCE_BPS = 1_500;

/** A market with almost no money in it has no meaningful shape yet. */
export const UNDERDOG_MIN_POT_USDC = 4;

export interface UnderdogSignal {
  /** True when the thin side is worth surfacing. */
  isUnderdog: boolean;
  /** Which side is thin. Null when the pool is balanced or empty. */
  minoritySide: "creator" | "challengers" | null;
  crowdedSide: "creator" | "challengers" | null;
  imbalanceBps: number;
  /**
   * Profit per unit of stake for joining the CHALLENGER side, in bps.
   * 10000 = doubling your stake. Payout asymmetry only.
   */
  challengerUpsideBps: number;
  /** Total-return multiple for a challenger, e.g. 1.9. */
  challengerReturnMultiple: number;
}

const NEUTRAL: UnderdogSignal = {
  isUnderdog: false,
  minoritySide: null,
  crowdedSide: null,
  imbalanceBps: 0,
  challengerUpsideBps: 0,
  challengerReturnMultiple: 0,
};

/**
 * Assess a market's pool shape.
 *
 * `probeStake` is the hypothetical stake the upside is quoted for. It matters: in
 * a pool market a large stake dilutes its own payout, so quoting upside without
 * naming a size would overstate what a real joiner gets.
 */
export function assessUnderdog(vs: VSData, probeStake = 2): UnderdogSignal {
  const creatorStake = vs.creator_stake ?? vs.stake_amount ?? 0;
  const challengerPool = vs.total_challenger_stake ?? 0;
  const potUsdc = creatorStake + challengerPool;
  if (potUsdc < UNDERDOG_MIN_POT_USDC) return NEUTRAL;

  const mode = toCanonicalMode({
    marketType: vs.market_type ?? "binary",
    oddsMode: vs.odds_mode ?? "pool",
    maxChallengers: vs.max_challengers ?? 1,
  });
  // A duel is equal stakes by definition and fixed odds posts its own multiple —
  // neither has an underdog side to discover.
  if (mode.settlementMode !== "pool") return NEUTRAL;

  const balance = poolBalance({
    creatorStakeUnits: usdcToUnits(creatorStake),
    challengerPoolUnits: usdcToUnits(challengerPool),
  });

  const payout = poolChallengerPayoutUnits({
    stakeUnits: usdcToUnits(probeStake),
    creatorStakeUnits: usdcToUnits(creatorStake),
    challengerPoolUnits: usdcToUnits(challengerPool) + usdcToUnits(probeStake),
  });
  const challengerUpsideBps = upsideBps(payout);

  return {
    isUnderdog: balance.imbalanceBps >= UNDERDOG_MIN_IMBALANCE_BPS,
    minoritySide: balance.minoritySide,
    crowdedSide: balance.crowdedSide,
    imbalanceBps: balance.imbalanceBps,
    challengerUpsideBps,
    challengerReturnMultiple:
      payout.returnedPrincipalUnits > 0n
        ? Number(payout.totalReturnUnits) / Number(payout.returnedPrincipalUnits)
        : 0,
  };
}

/**
 * True when joining the CHALLENGER side is the underdog position.
 *
 * This is what the explorer badge means: the side a browsing user can take is the
 * thin one. A market where the creator is the underdog is still lopsided, but a
 * joiner cannot take that side, so badging it would be misleading.
 */
export function isChallengerUnderdog(signal: UnderdogSignal): boolean {
  return signal.isUnderdog && signal.minoritySide === "challengers";
}

/** Sort key: higher challenger upside first, id as a stable tiebreak. */
export function compareByUpside(a: VSData, b: VSData, probeStake = 2): number {
  const upsideA = assessUnderdog(a, probeStake).challengerUpsideBps;
  const upsideB = assessUnderdog(b, probeStake).challengerUpsideBps;
  if (upsideA !== upsideB) return upsideB - upsideA;
  return b.id - a.id;
}
