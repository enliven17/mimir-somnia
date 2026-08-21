import assert from "node:assert/strict";
import test from "node:test";

import {
  CONVICTION_VERSION,
  STAKE_CAP_USDC,
  computeConviction,
  computeStreak,
  scorePosition,
  stakeFactor,
  timeFactor,
  underdogFactor,
  type Outcome,
  type ScoredPosition,
} from "../../lib/scoring";

const OPENED = 1_000_000;
const DEADLINE = 2_000_000;

function position(overrides: Partial<ScoredPosition> & { claimId: number }): ScoredPosition {
  return {
    outcome: "win",
    stakeUsdc: 10,
    resolvedAt: DEADLINE + 1_000,
    enteredAt: OPENED,
    deadlineAt: DEADLINE,
    openedAt: OPENED,
    ...overrides,
  };
}

function sequence(outcomes: Outcome[]): ScoredPosition[] {
  return outcomes.map((outcome, i) =>
    position({ claimId: i + 1, outcome, resolvedAt: DEADLINE + (i + 1) * 1_000 }),
  );
}

// ── Streaks: a refund is not a result ─────────────────────────────────────────

test("consecutive wins build a positive streak", () => {
  const stats = computeStreak(sequence(["win", "win", "win"]));
  assert.equal(stats.currentStreak, 3);
  assert.equal(stats.bestStreak, 3);
  assert.equal(stats.winRateBps, 10_000);
});

test("a loss resets the run and starts a negative one", () => {
  const stats = computeStreak(sequence(["win", "win", "loss"]));
  assert.equal(stats.currentStreak, -1);
  assert.equal(stats.bestStreak, 2);
  assert.equal(stats.worstStreak, -1);
});

test("a refund leaves a streak untouched, it does not break it", () => {
  // A user who staked, drew, then staked again has not stopped being right, and
  // breaking the run would punish them for an ambiguity that was not their doing.
  // The run continues across the refund, but the refund itself adds no link:
  // two wins is a streak of two, not three.
  const stats = computeStreak(sequence(["win", "refund", "win"]));
  assert.equal(stats.currentStreak, 2);
  assert.equal(stats.refunds, 1);
  // And a refund is not counted in the rate either.
  assert.equal(stats.resolvedCount, 2);
  assert.equal(stats.winRateBps, 10_000);
});

test("a refund does not rescue a losing run either", () => {
  const stats = computeStreak(sequence(["loss", "refund", "loss"]));
  assert.equal(stats.currentStreak, -2);
  assert.equal(stats.worstStreak, -2);
});

test("pending positions are ignored entirely", () => {
  const stats = computeStreak([
    position({ claimId: 1, outcome: "win" }),
    position({ claimId: 2, outcome: "pending", resolvedAt: undefined }),
  ]);
  assert.equal(stats.resolvedCount, 1);
  assert.equal(stats.currentStreak, 1);
});

test("an empty history has a null win rate, not zero", () => {
  // 0% implies losses that did not happen.
  const stats = computeStreak([]);
  assert.equal(stats.winRateBps, null);
  assert.equal(stats.currentStreak, 0);
});

test("only refunds also leaves a null win rate", () => {
  assert.equal(computeStreak(sequence(["refund", "refund"])).winRateBps, null);
});

test("streaks are computed in resolution order, not input order", () => {
  // A resync can deliver rows in any order; the score must not depend on it.
  const forward = sequence(["loss", "win", "win"]);
  const shuffled = [forward[2], forward[0], forward[1]];
  assert.deepEqual(computeStreak(shuffled), computeStreak(forward));
});

test("the win rate is a rounded basis-point integer", () => {
  const stats = computeStreak(sequence(["win", "win", "loss"]));
  assert.equal(stats.winRateBps, 6_667);
  assert.equal(Number.isInteger(stats.winRateBps), true);
});

// ── Stake factor: money must not buy rank ─────────────────────────────────────

test("stake weight is logarithmic, so doubling a stake does not double the score", () => {
  const small = stakeFactor(10);
  const double = stakeFactor(20);
  assert.ok(double > small);
  assert.ok(double < small * 2, "a linear weight would let wallets buy the leaderboard");
});

test("stake weight is capped, so a whale gains nothing past the cap", () => {
  assert.equal(stakeFactor(STAKE_CAP_USDC), 1);
  assert.equal(stakeFactor(STAKE_CAP_USDC * 100), 1);
});

test("a zero or negative stake weighs nothing", () => {
  assert.equal(stakeFactor(0), 0);
  assert.equal(stakeFactor(-5), 0);
});

// ── Time factor ───────────────────────────────────────────────────────────────

test("entering at open scores full timing credit, at the deadline none", () => {
  assert.equal(timeFactor({ enteredAt: OPENED, openedAt: OPENED, deadlineAt: DEADLINE }), 1);
  assert.equal(timeFactor({ enteredAt: DEADLINE, openedAt: OPENED, deadlineAt: DEADLINE }), 0);
});

test("entering halfway scores half", () => {
  const mid = OPENED + (DEADLINE - OPENED) / 2;
  assert.equal(timeFactor({ enteredAt: mid, openedAt: OPENED, deadlineAt: DEADLINE }), 0.5);
});

test("a position after the deadline scores zero timing, never negative", () => {
  assert.equal(
    timeFactor({ enteredAt: DEADLINE + 500_000, openedAt: OPENED, deadlineAt: DEADLINE }),
    0,
  );
});

test("a zero-length window scores zero rather than dividing by zero", () => {
  assert.equal(timeFactor({ enteredAt: OPENED, openedAt: OPENED, deadlineAt: OPENED }), 0);
});

// ── Underdog factor ───────────────────────────────────────────────────────────

test("an even market gives no underdog bonus", () => {
  assert.equal(underdogFactor(5_000), 1);
});

test("the thinner the side, the larger the weight, up to 2x", () => {
  assert.equal(underdogFactor(2_500), 1.5);
  assert.equal(underdogFactor(0), 2);
});

test("backing the crowded side earns no penalty and no bonus", () => {
  // Above an even split the factor stays 1 — this is a bonus, not a punishment.
  assert.equal(underdogFactor(7_500), 1);
  assert.equal(underdogFactor(10_000), 1);
});

test("an unknown side share is treated as neutral", () => {
  assert.equal(underdogFactor(undefined), 1);
});

test("an out-of-range share is clamped instead of distorting the score", () => {
  assert.equal(underdogFactor(-1_000), 2);
  assert.equal(underdogFactor(99_999), 1);
});

// ── Per-position score ────────────────────────────────────────────────────────

test("a win scores positive and a loss the mirror image", () => {
  const win = scorePosition(position({ claimId: 1, outcome: "win" }));
  const loss = scorePosition(position({ claimId: 1, outcome: "loss" }));
  assert.ok(win.score > 0);
  assert.equal(loss.score, -win.score);
});

test("refunds and pending positions score exactly zero", () => {
  assert.equal(scorePosition(position({ claimId: 1, outcome: "refund" })).score, 0);
  assert.equal(scorePosition(position({ claimId: 1, outcome: "pending" })).score, 0);
});

test("an early underdog win outscores a late crowded win of the same stake", () => {
  const early = scorePosition(
    position({ claimId: 1, enteredAt: OPENED, sideShareBpsAtEntry: 1_000 }),
  );
  const late = scorePosition(
    position({
      claimId: 2,
      enteredAt: OPENED + (DEADLINE - OPENED) * 0.9,
      sideShareBpsAtEntry: 9_000,
    }),
  );
  assert.ok(early.score > late.score);
});

// ── Aggregate ─────────────────────────────────────────────────────────────────

test("conviction is versioned so a formula change is visible", () => {
  assert.equal(computeConviction([]).version, CONVICTION_VERSION);
});

test("refunds and pending are counted as ignored, not scored", () => {
  const stats = computeConviction([
    position({ claimId: 1, outcome: "win" }),
    position({ claimId: 2, outcome: "refund" }),
    position({ claimId: 3, outcome: "pending", resolvedAt: undefined }),
  ]);
  assert.equal(stats.positionsScored, 1);
  assert.equal(stats.positionsIgnored, 2);
});

test("realised PnL is reported beside the score, never folded into it", () => {
  // Mixing a money number into a ranking weight would make a big wallet look
  // like a better forecaster.
  const stats = computeConviction(
    [position({ claimId: 1, outcome: "win", stakeUsdc: 10 })],
    new Map([[1, 21]]),
  );
  assert.equal(stats.realizedPnlUsdc, 11);
  assert.notEqual(stats.score, stats.realizedPnlUsdc);
});

test("a loss subtracts the stake from PnL", () => {
  const stats = computeConviction([position({ claimId: 1, outcome: "loss", stakeUsdc: 7 })]);
  assert.equal(stats.realizedPnlUsdc, -7);
});

test("a refund moves PnL by zero", () => {
  const stats = computeConviction([position({ claimId: 1, outcome: "refund", stakeUsdc: 7 })]);
  assert.equal(stats.realizedPnlUsdc, 0);
});

test("a win with no recorded payout does not invent profit", () => {
  const stats = computeConviction([position({ claimId: 1, outcome: "win", stakeUsdc: 10 })]);
  assert.equal(stats.realizedPnlUsdc, 0);
});

test("a whale cannot out-stake a better forecaster into the lead", () => {
  // One late, crowded, maximum-stake win against three early underdog wins at a
  // tenth of the size.
  const whale = computeConviction([
    position({
      claimId: 1,
      stakeUsdc: 10_000,
      enteredAt: OPENED + (DEADLINE - OPENED) * 0.95,
      sideShareBpsAtEntry: 9_500,
    }),
  ]);
  const forecaster = computeConviction([
    position({ claimId: 2, stakeUsdc: 10, sideShareBpsAtEntry: 1_000 }),
    position({ claimId: 3, stakeUsdc: 10, sideShareBpsAtEntry: 1_000 }),
    position({ claimId: 4, stakeUsdc: 10, sideShareBpsAtEntry: 1_000 }),
  ]);
  assert.ok(forecaster.score > whale.score);
});

test("early underdog positions are counted for the badge", () => {
  const stats = computeConviction([
    position({ claimId: 1, sideShareBpsAtEntry: 1_000, enteredAt: OPENED }),
    position({
      claimId: 2,
      sideShareBpsAtEntry: 1_000,
      enteredAt: OPENED + (DEADLINE - OPENED) * 0.9,
    }),
  ]);
  assert.equal(stats.earlyUnderdogCount, 1);
});

test("aggregate order does not change the result", () => {
  const positions = [
    position({ claimId: 1, outcome: "win", sideShareBpsAtEntry: 2_000 }),
    position({ claimId: 2, outcome: "loss", sideShareBpsAtEntry: 8_000 }),
    position({ claimId: 3, outcome: "refund" }),
  ];
  assert.deepEqual(
    computeConviction([...positions].reverse()),
    computeConviction(positions),
  );
});
