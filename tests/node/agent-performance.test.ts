import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyTrade, computeAgentPerformance, usdcDisplayToAtomic, windowSinceMs,
  type AgentTradeRow,
} from "../../lib/agents/performance";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

function trade(overrides: Partial<AgentTradeRow> = {}): AgentTradeRow {
  return {
    claimId: 1, role: "creator", stake: 2, opposingStake: 2, potentialPayout: 0,
    state: "resolved", winnerSide: "creator", settledAt: NOW - HOUR,
    category: "crypto", question: "q",
    ...overrides,
  };
}

test("display USDC converts without float drift", () => {
  assert.equal(usdcDisplayToAtomic(2), 2_000_000n);
  // 2.05 * 1e6 is 2049999.9999999998 as a float multiply.
  assert.equal(usdcDisplayToAtomic(2.05), 2_050_000n);
  assert.equal(usdcDisplayToAtomic(0.000001), 1n);
  assert.equal(usdcDisplayToAtomic(0), 0n);
  assert.equal(usdcDisplayToAtomic(-1.5), -1_500_000n);
  // Beyond six decimals the chain has no room either; truncation, not a throw.
  assert.equal(usdcDisplayToAtomic(1.0000004), 1_000_000n);
  assert.equal(usdcDisplayToAtomic(Number.NaN), 0n);
});

test("a winning creator gains the pooled challenger stake", () => {
  const result = classifyTrade(trade({ stake: 2, opposingStake: 2, winnerSide: "creator" }));
  assert.equal(result.outcome, "won");
  assert.equal(result.pnlAtomic, 2_000_000n);
});

test("a losing side loses exactly its stake, never more", () => {
  const creator = classifyTrade(trade({ stake: 2, opposingStake: 6, winnerSide: "challengers" }));
  assert.equal(creator.outcome, "lost");
  assert.equal(creator.pnlAtomic, -2_000_000n, "a creator cannot lose more than it staked");

  const challenger = classifyTrade(trade({ role: "challenger", stake: 3, potentialPayout: 6, winnerSide: "creator" }));
  assert.equal(challenger.outcome, "lost");
  assert.equal(challenger.pnlAtomic, -3_000_000n);
});

test("a winning challenger gains payout minus its own stake", () => {
  const result = classifyTrade(trade({ role: "challenger", stake: 2, potentialPayout: 3.5, winnerSide: "challengers" }));
  assert.equal(result.outcome, "won");
  assert.equal(result.pnlAtomic, 1_500_000n, "payout is gross, so the stake comes back out");
});

test("draws, unresolvable settlements and cancellations refund rather than score", () => {
  for (const winnerSide of ["draw", "unresolvable", ""]) {
    const result = classifyTrade(trade({ winnerSide }));
    assert.equal(result.outcome, "refunded", `${winnerSide || "(empty)"} must refund`);
    assert.equal(result.pnlAtomic, 0n);
  }
  const cancelled = classifyTrade(trade({ state: "cancelled", winnerSide: "" }));
  assert.equal(cancelled.outcome, "refunded");
  assert.equal(cancelled.pnlAtomic, 0n);
});

test("an unsettled market is exposure, not profit in either direction", () => {
  for (const state of ["open", "active"]) {
    const result = classifyTrade(trade({ state, winnerSide: "" }));
    assert.equal(result.outcome, "open");
    assert.equal(result.pnlAtomic, 0n);
  }
});

test("totals separate realised P&L from open exposure", () => {
  const { performance } = computeAgentPerformance([
    trade({ claimId: 1, stake: 2, opposingStake: 2, winnerSide: "creator" }),
    trade({ claimId: 2, stake: 2, opposingStake: 4, winnerSide: "challengers" }),
    trade({ claimId: 3, stake: 5, state: "active", winnerSide: "" }),
    trade({ claimId: 4, stake: 1, winnerSide: "draw" }),
  ]);
  assert.equal(performance.trades, 4);
  assert.equal(performance.settled, 3, "the active market is not settled");
  assert.equal(performance.wins, 1);
  assert.equal(performance.losses, 1);
  assert.equal(performance.refunds, 1);
  assert.equal(performance.realisedPnlAtomic, 0n, "+2 then -2");
  assert.equal(performance.openExposureAtomic, 5_000_000n);
  assert.equal(performance.volumeAtomic, 10_000_000n, "volume counts every stake");
  assert.equal(performance.winRateBps, 5_000, "refunds are not decisions");
  assert.equal(performance.bestPnlAtomic, 2_000_000n);
  assert.equal(performance.worstPnlAtomic, -2_000_000n);
});

test("a time window filters settled history but never hides open exposure", () => {
  const rows = [
    trade({ claimId: 1, settledAt: NOW - 40 * HOUR, winnerSide: "creator", stake: 2, opposingStake: 2 }),
    trade({ claimId: 2, settledAt: NOW - 2 * HOUR, winnerSide: "challengers", stake: 3 }),
    trade({ claimId: 3, state: "active", winnerSide: "", settledAt: NOW - 90 * HOUR, stake: 4 }),
  ];
  const day = computeAgentPerformance(rows, { sinceMs: NOW - 24 * HOUR }).performance;
  assert.equal(day.settled, 1, "the 40h-old settlement falls outside 24h");
  assert.equal(day.realisedPnlAtomic, -3_000_000n);
  assert.equal(day.openExposureAtomic, 4_000_000n, "an old open stake is still exposure today");

  const all = computeAgentPerformance(rows).performance;
  assert.equal(all.settled, 2);
  assert.equal(all.realisedPnlAtomic, -1_000_000n);
});

test("win rate is zero rather than NaN when nothing has been decided", () => {
  const { performance } = computeAgentPerformance([trade({ state: "active", winnerSide: "" })]);
  assert.equal(performance.winRateBps, 0);
});

test("the all-time window has no lower bound", () => {
  assert.equal(windowSinceMs("all", NOW), undefined);
  assert.equal(windowSinceMs("24h", NOW), NOW - 24 * HOUR);
  assert.equal(windowSinceMs("7d", NOW), NOW - 168 * HOUR);
  assert.equal(windowSinceMs("30d", NOW), NOW - 720 * HOUR);
});
