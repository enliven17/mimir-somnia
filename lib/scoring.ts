/**
 * Off-chain scoring: streaks and conviction.
 *
 * Neither is a settlement mode. Nothing here moves money — these are read-index
 * projections over resolved claims, which is why a new scoring rule needs no
 * contract change.
 *
 * Two rules run through both:
 *
 *  1. **A refund is not a result.** Draws, unresolvable outcomes and cancellations
 *     return every stake. Counting them would invent wins and losses, so they
 *     leave a streak untouched rather than breaking it.
 *  2. **Money must not buy the leaderboard.** Conviction weights stake
 *     logarithmically and caps it, so a large wallet cannot simply out-spend
 *     better forecasters into first place.
 *
 * Everything is derived from the resolved set, so wiping the read-index and
 * rebuilding from chain events reproduces identical scores.
 */

export type Outcome = "win" | "loss" | "refund" | "pending";

export interface ScoredPosition {
  claimId: number;
  /** Whose side the actor was on. */
  outcome: Outcome;
  /** Stake in display USDC. */
  stakeUsdc: number;
  /** When the claim resolved, epoch ms. Absent while pending. */
  resolvedAt?: number;
  /** When the actor took the position, epoch ms. */
  enteredAt: number;
  /** Claim deadline, epoch ms — used for the timing factor. */
  deadlineAt: number;
  /** When the market opened, epoch ms. */
  openedAt: number;
  /** Actor's share of its own side's pool at entry, in basis points. */
  sideShareBpsAtEntry?: number;
  category?: string;
}

// ── Streaks ───────────────────────────────────────────────────────────────────

export interface StreakStats {
  /** Positive for a win run, negative for a loss run, 0 when neutral. */
  currentStreak: number;
  bestStreak: number;
  worstStreak: number;
  /** Decisive results only. */
  resolvedCount: number;
  wins: number;
  losses: number;
  /** Refunds, shown for completeness but excluded from every rate. */
  refunds: number;
  /** Wins / decisive results, in basis points. Null with no decisive results. */
  winRateBps: number | null;
}

/**
 * Streaks over the resolved set, newest last.
 *
 * A refund does NOT break a streak. A user who staked, drew, and staked again has
 * not stopped being right — and breaking the run would punish them for an
 * ambiguity that was not their doing.
 */
export function computeStreak(positions: ScoredPosition[]): StreakStats {
  const decided = positions
    .filter((p) => p.outcome === "win" || p.outcome === "loss" || p.outcome === "refund")
    .sort((a, b) => (a.resolvedAt ?? 0) - (b.resolvedAt ?? 0) || a.claimId - b.claimId);

  let current = 0;
  let best = 0;
  let worst = 0;
  let wins = 0;
  let losses = 0;
  let refunds = 0;

  for (const position of decided) {
    if (position.outcome === "refund") {
      refunds += 1;
      continue; // deliberately does not touch `current`
    }
    if (position.outcome === "win") {
      wins += 1;
      current = current > 0 ? current + 1 : 1;
      best = Math.max(best, current);
    } else {
      losses += 1;
      current = current < 0 ? current - 1 : -1;
      worst = Math.min(worst, current);
    }
  }

  const resolvedCount = wins + losses;
  return {
    currentStreak: current,
    bestStreak: best,
    worstStreak: worst,
    resolvedCount,
    wins,
    losses,
    refunds,
    winRateBps: resolvedCount === 0 ? null : Math.round((wins / resolvedCount) * 10_000),
  };
}

// ── Conviction ────────────────────────────────────────────────────────────────

/**
 * Conviction v1. Versioned because the formula WILL change, and a leaderboard
 * that silently changes its meaning is worse than one that admits a new version.
 *
 *   score = correctness × stakeFactor × timeFactor × underdogFactor
 *
 * Deliberately excluded from v1: evidence quality and self-reported confidence.
 * Both are subjective and gameable, and mixing an unvalidated signal into a
 * monetary-looking score makes the score untrustworthy. They are surfaced
 * separately until calibrated.
 */
export const CONVICTION_VERSION = 1;

/** Stake above this adds nothing — the cap that stops wallets buying rank. */
export const STAKE_CAP_USDC = 100;

export interface ConvictionFactors {
  /** +1 for a win, -1 for a loss. Refunds and pending score nothing. */
  correctness: number;
  /** log-scaled and capped stake weight, in [0, 1]. */
  stakeFactor: number;
  /** How early in the market's life the position was taken, in [0, 1]. */
  timeFactor: number;
  /** Extra weight for backing the thin side, in [1, 2]. */
  underdogFactor: number;
  score: number;
}

/**
 * Logarithmic and capped. Doubling a stake must not double the score, or the
 * leaderboard becomes a ranking of wallet sizes.
 */
export function stakeFactor(stakeUsdc: number, cap = STAKE_CAP_USDC): number {
  if (!Number.isFinite(stakeUsdc) || stakeUsdc <= 0) return 0;
  const capped = Math.min(stakeUsdc, cap);
  return Math.log10(1 + capped) / Math.log10(1 + cap);
}

/**
 * 1 at the moment the market opens, approaching 0 at the deadline.
 *
 * Rewards taking a view before the outcome is obvious. A position opened after
 * the deadline scores 0 on timing rather than going negative.
 */
export function timeFactor(position: Pick<ScoredPosition, "enteredAt" | "openedAt" | "deadlineAt">): number {
  const window = position.deadlineAt - position.openedAt;
  if (window <= 0) return 0;
  const elapsed = position.enteredAt - position.openedAt;
  if (elapsed <= 0) return 1;
  if (elapsed >= window) return 0;
  return 1 - elapsed / window;
}

/**
 * Backing the minority side is worth more, because it is the position that was
 * not already priced in.
 *
 * `sideShareBpsAtEntry` is the actor's own side's share of the pot. 5000 (an even
 * market) gives 1; a thin side approaches 2. This is a scoring weight, never a
 * statement about the chance of winning.
 */
export function underdogFactor(sideShareBpsAtEntry: number | undefined): number {
  if (sideShareBpsAtEntry === undefined) return 1;
  const clamped = Math.max(0, Math.min(10_000, sideShareBpsAtEntry));
  // 5000 → 1.0, 2500 → 1.5, 0 → 2.0
  return 1 + (5_000 - Math.min(clamped, 5_000)) / 5_000;
}

export function scorePosition(position: ScoredPosition): ConvictionFactors {
  const correctness =
    position.outcome === "win" ? 1 : position.outcome === "loss" ? -1 : 0;
  const stake = stakeFactor(position.stakeUsdc);
  const time = timeFactor(position);
  const underdog = underdogFactor(position.sideShareBpsAtEntry);
  return {
    correctness,
    stakeFactor: stake,
    timeFactor: time,
    underdogFactor: underdog,
    score: correctness * stake * time * underdog,
  };
}

export interface ConvictionStats {
  version: number;
  /** Sum of per-position scores. */
  score: number;
  positionsScored: number;
  /** Positions that contributed nothing: refunds and pending. */
  positionsIgnored: number;
  /** Realised profit and loss in display USDC, reported alongside but never mixed in. */
  realizedPnlUsdc: number;
  /** Positions taken while the actor's side was the minority. */
  earlyUnderdogCount: number;
}

/**
 * Aggregate conviction for one actor.
 *
 * Realised PnL is reported next to the score, never folded into it: one is a
 * money number and the other is a ranking weight, and combining them would make
 * a large wallet look like a better forecaster.
 */
export function computeConviction(
  positions: ScoredPosition[],
  payouts: Map<number, number> = new Map(),
): ConvictionStats {
  let score = 0;
  let scored = 0;
  let ignored = 0;
  let pnl = 0;
  let earlyUnderdog = 0;

  for (const position of positions) {
    const factors = scorePosition(position);
    if (factors.correctness === 0) {
      ignored += 1;
    } else {
      score += factors.score;
      scored += 1;
      if (factors.underdogFactor > 1 && factors.timeFactor > 0.5) earlyUnderdog += 1;
    }

    if (position.outcome === "win") {
      pnl += (payouts.get(position.claimId) ?? position.stakeUsdc) - position.stakeUsdc;
    } else if (position.outcome === "loss") {
      pnl -= position.stakeUsdc;
    }
    // A refund returns the stake, so it moves PnL by zero.
  }

  return {
    version: CONVICTION_VERSION,
    score: Math.round(score * 1e6) / 1e6,
    positionsScored: scored,
    positionsIgnored: ignored,
    realizedPnlUsdc: Math.round(pnl * 1e6) / 1e6,
    earlyUnderdogCount: earlyUnderdog,
  };
}
