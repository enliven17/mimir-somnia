import assert from "node:assert/strict";
import test from "node:test";
import { assetsForRedemption, basketExposure, highWaterMarkFee, sharesForDeposit, simulateVirtualBasket, validateBasket } from "../../lib/baskets";

const weights = [
  { agentId: "a", weightBps: 4_000, category: "crypto", mode: "pool" },
  { agentId: "b", weightBps: 3_000, category: "sports", mode: "duel" },
  { agentId: "c", weightBps: 3_000, category: "sports", mode: "pool", stale: true },
];
const policy = { maxSingleAgentBps: 5_000, maxCategoryBps: 6_000, staleSignalAction: "skip" as const, failedCopyAction: "keep_idle" as const };

test("virtual basket validates weights and exposes category/mode concentration", () => {
  assert.deepEqual(validateBasket(weights, policy), []);
  assert.deepEqual(basketExposure(weights), { categories: { crypto: 4_000, sports: 6_000 }, modes: { pool: 7_000, duel: 3_000 } });
});

test("stale agents stay idle and NAV/drawdown are deterministic atomic values", () => {
  const snapshots = simulateVirtualBasket(weights, [{ timestamp: 1, returnsBps: { a: 1_000, b: -500, c: 9_999 } }, { timestamp: 2, returnsBps: { a: -2_000, b: -1_000, c: 9_999 } }]);
  assert.equal(snapshots[0]!.navAtomic, 1_025_000_000n);
  assert.ok(snapshots[1]!.drawdownBps > 0);
});

test("high-water mark prevents repeated performance fees", () => {
  assert.deepEqual(highWaterMarkFee(1_100_000n, 1_000_000n, 1_000n), { feeAtomic: 10_000n, nextHighWaterMarkAtomic: 1_100_000n });
  assert.equal(highWaterMarkFee(1_050_000n, 1_100_000n, 1_000n).feeAtomic, 0n);
});

test("share conversions conserve atomic rounding and never overpay", () => {
  for (let assets = 1n; assets < 1_000n; assets += 7n) {
    const shares = sharesForDeposit(assets, 1_000_003n, 999_983n);
    if (shares === 0n) continue;
    assert.ok(assetsForRedemption(shares, 1_000_003n, 999_983n) <= assets);
  }
});
