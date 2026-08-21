import assert from "node:assert/strict";
import test from "node:test";

import {
  availableCreatorLiquidityUnits,
  fixedOddsCapacityUnits,
  fixedOddsPayoutUnits,
  fixedOddsReservedLiabilityUnits,
  isLowUpside,
  maxFixedOddsStakeUnits,
  poolBalance,
  poolChallengerPayoutUnits,
  poolCreatorPayoutUnits,
  previewChallengerPayout,
  upsideBps,
} from "../../lib/payout";
import { usdcToUnits } from "../../lib/usdc";

const U = usdcToUnits;

// ── The roadmap's golden example (TODO §6.1) ──────────────────────────────────
// 10 USDC creator, ten challengers at 10 USDC each.
//   NO wins  → each challenger receives 11 USDC (10 back + 1 profit)
//   YES wins → creator receives 110 USDC

test("golden: 10 creator / 10x10 challengers — a winning challenger gets 11", () => {
  const payout = poolChallengerPayoutUnits({
    stakeUnits: U(10),
    creatorStakeUnits: U(10),
    challengerPoolUnits: U(100),
  });
  assert.equal(payout.totalReturnUnits, U(11));
  assert.equal(payout.returnedPrincipalUnits, U(10));
  assert.equal(payout.netProfitUnits, U(1));
});

test("golden: the same market pays the creator 110 on a win", () => {
  const payout = poolCreatorPayoutUnits({
    creatorStakeUnits: U(10),
    challengerPoolUnits: U(100),
  });
  assert.equal(payout.totalReturnUnits, U(110));
  assert.equal(payout.returnedPrincipalUnits, U(10));
  assert.equal(payout.netProfitUnits, U(100));
});

test("golden: the whole challenger side is paid from the creator stake, no more", () => {
  // Ten identical challengers must not collectively receive more than
  // their principal plus the creator's entire stake.
  const each = poolChallengerPayoutUnits({
    stakeUnits: U(10),
    creatorStakeUnits: U(10),
    challengerPoolUnits: U(100),
  });
  assert.equal(each.totalReturnUnits * 10n, U(100) + U(10));
});

// ── Contract-exact integer behaviour ──────────────────────────────────────────

test("the pool share truncates exactly like Solidity integer division", () => {
  // 3 * 10 / 7 = 4.285… → floor 4 atomic units, not 4.285714
  const payout = poolChallengerPayoutUnits({
    stakeUnits: 3n,
    creatorStakeUnits: 10n,
    challengerPoolUnits: 7n,
  });
  assert.equal(payout.totalReturnUnits, 3n + 4n);
});

test("truncation never overpays across a lopsided pool", () => {
  // Three challengers of 1/1/1 atomic units against a creator stake of 5:
  // each floor(1*5/3) = 1, so 3 units of profit are paid out of 5 — dust stays
  // in escrow rather than the contract paying out more than it holds.
  const per = poolChallengerPayoutUnits({
    stakeUnits: 1n,
    creatorStakeUnits: 5n,
    challengerPoolUnits: 3n,
  });
  assert.equal(per.netProfitUnits, 1n);
  assert.ok(per.netProfitUnits * 3n <= 5n);
});

test("a sole challenger takes the creator's whole stake as profit", () => {
  const payout = poolChallengerPayoutUnits({
    stakeUnits: U(5),
    creatorStakeUnits: U(5),
    challengerPoolUnits: U(5),
  });
  assert.equal(payout.totalReturnUnits, U(10));
  assert.equal(payout.netProfitUnits, U(5));
});

test("an empty challenger pool returns the principal and nothing else", () => {
  const payout = poolChallengerPayoutUnits({
    stakeUnits: U(5),
    creatorStakeUnits: U(5),
    challengerPoolUnits: 0n,
  });
  assert.equal(payout.totalReturnUnits, U(5));
  assert.equal(payout.netProfitUnits, 0n);
});

// ── Fixed odds: total return, not profit ──────────────────────────────────────

test("20000 bps is 2x TOTAL RETURN, i.e. 1x profit", () => {
  const payout = fixedOddsPayoutUnits({ stakeUnits: U(10), challengerPayoutBps: 20_000 });
  assert.equal(payout.totalReturnUnits, U(20));
  assert.equal(payout.returnedPrincipalUnits, U(10));
  assert.equal(payout.netProfitUnits, U(10));
});

test("12500 bps returns 1.25x total, so 25% profit", () => {
  const payout = fixedOddsPayoutUnits({ stakeUnits: U(8), challengerPayoutBps: 12_500 });
  assert.equal(payout.totalReturnUnits, U(10));
  assert.equal(payout.netProfitUnits, U(2));
});

test("reserved creator liability is the challenger's profit, not the gross payout", () => {
  assert.equal(
    fixedOddsReservedLiabilityUnits({ stakeUnits: U(10), challengerPayoutBps: 20_000 }),
    U(10),
  );
});

test("available liquidity floors at zero and caps the next stake", () => {
  assert.equal(
    availableCreatorLiquidityUnits({ creatorStakeUnits: U(10), reservedLiabilityUnits: U(4) }),
    U(6),
  );
  assert.equal(
    availableCreatorLiquidityUnits({ creatorStakeUnits: U(10), reservedLiabilityUnits: U(30) }),
    0n,
  );
  // 6 USDC of liquidity backs a 6 USDC stake at 2x (profit 6), or 24 at 1.25x.
  assert.equal(
    maxFixedOddsStakeUnits({ availableLiquidityUnits: U(6), challengerPayoutBps: 20_000 }),
    U(6),
  );
  assert.equal(
    maxFixedOddsStakeUnits({ availableLiquidityUnits: U(6), challengerPayoutBps: 12_500 }),
    U(24),
  );
  // 1x or less can never be backed.
  assert.equal(
    maxFixedOddsStakeUnits({ availableLiquidityUnits: U(6), challengerPayoutBps: 10_000 }),
    0n,
  );
});

// ── Pool shape ────────────────────────────────────────────────────────────────

test("pool balance names the minority and crowded sides", () => {
  const lopsided = poolBalance({ creatorStakeUnits: U(10), challengerPoolUnits: U(90) });
  assert.equal(lopsided.creatorShareBps, 1_000);
  assert.equal(lopsided.minoritySide, "creator");
  assert.equal(lopsided.crowdedSide, "challengers");
  assert.equal(lopsided.imbalanceBps, 4_000);

  const even = poolBalance({ creatorStakeUnits: U(50), challengerPoolUnits: U(50) });
  assert.equal(even.minoritySide, null);
  assert.equal(even.crowdedSide, null);
  assert.equal(even.imbalanceBps, 0);
});

test("an empty market is reported as balanced, not as a divide by zero", () => {
  const empty = poolBalance({ creatorStakeUnits: 0n, challengerPoolUnits: 0n });
  assert.equal(empty.creatorShareBps, 5_000);
  assert.equal(empty.imbalanceBps, 0);
});

test("upside is measured against principal, and the crowded side reads as low upside", () => {
  // The golden example's challenger: risk 10 to win 1 → 1000 bps.
  const crowded = poolChallengerPayoutUnits({
    stakeUnits: U(10),
    creatorStakeUnits: U(10),
    challengerPoolUnits: U(100),
  });
  assert.equal(upsideBps(crowded), 1_000);
  assert.equal(isLowUpside(crowded), true);

  // Joining the thin side: risk 10 to win 90 → 900% = 90_000 bps.
  const thin = poolChallengerPayoutUnits({
    stakeUnits: U(10),
    creatorStakeUnits: U(90),
    challengerPoolUnits: U(10),
  });
  assert.equal(upsideBps(thin), 90_000);
  assert.equal(isLowUpside(thin), false);
});

test("zero upside is not flagged as low upside", () => {
  // No profit at all is a different UI state (nobody to win from yet).
  const alone = poolChallengerPayoutUnits({
    stakeUnits: U(10),
    creatorStakeUnits: 0n,
    challengerPoolUnits: U(10),
  });
  assert.equal(alone.netProfitUnits, 0n);
  assert.equal(isLowUpside(alone), false);
});

// ── Display preview: pre-join pool must not overstate ─────────────────────────

test("the preview divides by the pool AFTER the stake joins", () => {
  // Pool holds 90; joining with 10 makes it 100, so profit is 1 — not the 1.11
  // a pre-join denominator would promise.
  const preview = previewChallengerPayout({
    settlementMode: "pool",
    stake: 10,
    creatorStake: 10,
    challengerPoolBefore: 90,
  });
  assert.equal(preview.totalReturn, 11);
  assert.equal(preview.returnedPrincipal, 10);
  assert.equal(preview.netProfit, 1);
  assert.equal(preview.isLowUpside, true);
});

test("the first challenger preview does not divide by zero", () => {
  const preview = previewChallengerPayout({
    settlementMode: "pool",
    stake: 10,
    creatorStake: 10,
    challengerPoolBefore: 0,
  });
  assert.equal(preview.totalReturn, 20);
  assert.equal(preview.netProfit, 10);
});

test("duel preview is winner-takes-the-two-person-pot", () => {
  const preview = previewChallengerPayout({
    settlementMode: "duel",
    stake: 25,
    creatorStake: 25,
    challengerPoolBefore: 0,
  });
  assert.equal(preview.totalReturn, 50);
  assert.equal(preview.netProfit, 25);
  assert.equal(preview.totalReturnMultiple, 2);
});

test("fixed-odds preview reports a total-return multiple", () => {
  const preview = previewChallengerPayout({
    settlementMode: "fixed_odds",
    stake: 10,
    creatorStake: 100,
    challengerPoolBefore: 0,
    challengerPayoutBps: 30_000,
  });
  assert.equal(preview.totalReturn, 30);
  assert.equal(preview.netProfit, 20);
  assert.equal(preview.totalReturnMultiple, 3);
});

test("fractional USDC previews stay exact at 6 decimals", () => {
  const preview = previewChallengerPayout({
    settlementMode: "pool",
    stake: 0.5,
    creatorStake: 1.25,
    challengerPoolBefore: 0.25,
  });
  // pool after join = 0.75 → share = floor(500000 * 1250000 / 750000) = 833333
  assert.equal(preview.totalReturn, 1.333333);
  assert.equal(preview.netProfit, 0.833333);
});

// ── Fixed-odds capacity (§6.3) ────────────────────────────────────────────────

test("capacity is stake divided by the promised profit, not by the multiple", () => {
  // At 2x total return the profit is 1x, so a 10 USDC creator can absorb 10 USDC.
  assert.equal(
    fixedOddsCapacityUnits({ creatorStakeUnits: U(10), challengerPayoutBps: 20_000 }),
    U(10),
  );
  // At 3x the profit is 2x, so the same creator can absorb only 5.
  assert.equal(
    fixedOddsCapacityUnits({ creatorStakeUnits: U(10), challengerPayoutBps: 30_000 }),
    U(5),
  );
  // At 1.25x the profit is 0.25x, so capacity is four times the stake.
  assert.equal(
    fixedOddsCapacityUnits({ creatorStakeUnits: U(10), challengerPayoutBps: 12_500 }),
    U(40),
  );
});

test("capacity and liability agree at the limit", () => {
  // Filling a market to capacity must reserve exactly the creator's stake.
  const creatorStake = U(10);
  for (const bps of [12_500, 15_000, 20_000, 30_000]) {
    const capacity = fixedOddsCapacityUnits({ creatorStakeUnits: creatorStake, challengerPayoutBps: bps });
    const reserved = fixedOddsReservedLiabilityUnits({ stakeUnits: capacity, challengerPayoutBps: bps });
    assert.ok(reserved <= creatorStake, `${bps} reserved ${reserved} > stake ${creatorStake}`);
  }
});

test("a multiple at or below 1x has no capacity rather than infinite capacity", () => {
  // validateMode rejects these anyway; dividing by zero would render a market that
  // can absorb anything.
  assert.equal(fixedOddsCapacityUnits({ creatorStakeUnits: U(10), challengerPayoutBps: 10_000 }), 0n);
  assert.equal(fixedOddsCapacityUnits({ creatorStakeUnits: U(10), challengerPayoutBps: 0 }), 0n);
});

test("an unstaked creator can absorb nothing", () => {
  assert.equal(fixedOddsCapacityUnits({ creatorStakeUnits: 0n, challengerPayoutBps: 20_000 }), 0n);
});

test("capacity rounds down so it never promises a unit the creator cannot cover", () => {
  // 3 units at 1.5x: profit per unit is 0.5, so capacity is 6 exactly; at 1.3x the
  // division is inexact and must floor.
  assert.equal(fixedOddsCapacityUnits({ creatorStakeUnits: 3n, challengerPayoutBps: 15_000 }), 6n);
  const inexact = fixedOddsCapacityUnits({ creatorStakeUnits: 10n, challengerPayoutBps: 13_000 });
  const reserved = fixedOddsReservedLiabilityUnits({ stakeUnits: inexact, challengerPayoutBps: 13_000 });
  assert.ok(reserved <= 10n);
});
