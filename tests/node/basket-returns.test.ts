import assert from "node:assert/strict";
import test from "node:test";

import { dailyReturnPoints, type BasketAgentResult } from "../../lib/baskets";

const DAY = 86_400_000;
const DAY_ONE = 3 * DAY;

function result(overrides: Partial<BasketAgentResult> = {}): BasketAgentResult {
  return {
    agentId: "alpha", settledAt: DAY_ONE + 3_600_000,
    pnlAtomic: 2_000_000n, stakeAtomic: 2_000_000n,
    ...overrides,
  };
}

test("a day's return is P&L over what was staked that day", () => {
  const points = dailyReturnPoints([result({ pnlAtomic: 2_000_000n, stakeAtomic: 2_000_000n })]);
  assert.equal(points.length, 1);
  // Doubled the stake: +100% is 10000 bps.
  assert.equal(points[0].returnsBps.alpha, 10_000);
});

test("stake-weighting keeps a large decision from being averaged away", () => {
  // A 10 USDC win and a 1 USDC loss are not "roughly break even".
  const points = dailyReturnPoints([
    result({ pnlAtomic: 10_000_000n, stakeAtomic: 10_000_000n }),
    result({ pnlAtomic: -1_000_000n, stakeAtomic: 1_000_000n }),
  ]);
  // (10 - 1) / 11 = 81.81%
  assert.equal(points[0].returnsBps.alpha, 8_181);
});

test("losses come through negative", () => {
  const points = dailyReturnPoints([result({ pnlAtomic: -2_000_000n, stakeAtomic: 2_000_000n })]);
  assert.equal(points[0].returnsBps.alpha, -10_000);
});

test("settlements are bucketed by day and returned in order", () => {
  const points = dailyReturnPoints([
    result({ settledAt: DAY_ONE + 2 * DAY + 100 }),
    result({ settledAt: DAY_ONE + 100 }),
  ]);
  assert.equal(points.length, 2, "two different days, two points");
  assert.ok(points[0].timestamp < points[1].timestamp, "points must be chronological");
  assert.equal(points[0].timestamp % DAY, 0, "buckets align to day boundaries");
});

test("two settlements on the same day collapse into one point", () => {
  const points = dailyReturnPoints([
    result({ settledAt: DAY_ONE + 1_000 }),
    result({ settledAt: DAY_ONE + 20 * 3_600_000 }),
  ]);
  assert.equal(points.length, 1);
});

test("a day nobody settled on produces no point at all", () => {
  // An idle agent must read as a flat line, not as a zero dragging the average down.
  const points = dailyReturnPoints([result({ settledAt: DAY_ONE })]);
  assert.equal(points.length, 1);
  assert.deepEqual(Object.keys(points[0].returnsBps), ["alpha"]);
});

test("a zero stake cannot divide by zero", () => {
  assert.deepEqual(dailyReturnPoints([result({ stakeAtomic: 0n, pnlAtomic: 0n })]), []);
  assert.deepEqual(dailyReturnPoints([result({ stakeAtomic: -5n })]), []);
});

test("members are reported separately on the same day", () => {
  const points = dailyReturnPoints([
    result({ agentId: "alpha", pnlAtomic: 2_000_000n, stakeAtomic: 2_000_000n }),
    result({ agentId: "beta", pnlAtomic: -2_000_000n, stakeAtomic: 2_000_000n }),
  ]);
  assert.equal(points.length, 1);
  assert.equal(points[0].returnsBps.alpha, 10_000);
  assert.equal(points[0].returnsBps.beta, -10_000);
});

test("an empty history is an empty curve, not a crash", () => {
  assert.deepEqual(dailyReturnPoints([]), []);
});
