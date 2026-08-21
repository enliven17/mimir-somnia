import assert from "node:assert/strict";
import test from "node:test";
import { refundSquadPool, settleSquadPool } from "../../lib/squad-pool";

test("proportional payouts conserve escrow and charge fees only on profit", () => {
  const settled = settleSquadPool([{ address: "a", stakeAtomic: 3_000_001n }, { address: "b", stakeAtomic: 7_000_003n }], 9_000_007n, 500n);
  assert.equal(settled.totalPaidAtomic + settled.totalFeesAtomic + settled.dustAtomic, settled.totalDepositedAtomic);
  assert.equal(settled.dustAtomic, 0n);
  for (const payout of settled.payouts) {
    assert.ok(payout.netAtomic >= payout.principalAtomic);
    assert.equal(payout.feeAtomic, ((payout.grossAtomic - payout.principalAtomic) * 500n) / 10_000n);
  }
});

test("cancel refunds both sides without fees", () => {
  const refunds = refundSquadPool([{ address: "a", stakeAtomic: 1n }, { address: "b", stakeAtomic: 9n }]);
  assert.deepEqual(refunds.map((item) => item.refundAtomic), [1n, 9n]);
  assert.ok(refunds.every((item) => item.feeAtomic === 0n));
});

test("deterministic fuzz covers pool imbalance, late liquidity and fee invariants", () => {
  let seed = 0x5eed1234;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
  for (let run = 0; run < 3_000; run++) {
    const count = 1 + (random() % 25);
    const winners = Array.from({ length: count }, (_, index) => ({ address: `winner-${index}`, stakeAtomic: BigInt(1 + (random() % 10_000_000)) }));
    const losingPool = BigInt(random() % 100_000_000);
    const feeBps = BigInt(random() % 1_001);
    const result = settleSquadPool(winners, losingPool, feeBps);
    assert.equal(result.totalPaidAtomic + result.totalFeesAtomic + result.dustAtomic, result.totalDepositedAtomic);
    assert.equal(result.dustAtomic, 0n);
    assert.ok(result.payouts.every((item) => item.netAtomic >= item.principalAtomic));
  }
});
