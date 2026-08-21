import assert from "node:assert/strict";
import test from "node:test";

import {
  FEE_SCHEDULE, MAX_TOTAL_FEE_BPS, scheduleTotalBps, splitAttributedFees,
} from "../../lib/fees";

const PLATFORM = "0x1111111111111111111111111111111111111111";
const AGENT_OWNER = "0x2222222222222222222222222222222222222222";
const BASKET_CREATOR = "0x3333333333333333333333333333333333333333";
const TRADER = "0x4444444444444444444444444444444444444444";

const USDC = (n: number) => BigInt(Math.round(n * 1_000_000));

function split(overrides: Partial<Parameters<typeof splitAttributedFees>[0]> = {}) {
  return splitAttributedFees({
    principalUnits: USDC(100),
    grossPayoutUnits: USDC(200),   // 100 profit
    outcome: "creator_wins",
    earner: TRADER,
    platformRecipient: PLATFORM,
    agentOwnerRecipient: AGENT_OWNER,
    basketCreatorRecipient: BASKET_CREATOR,
    ...overrides,
  });
}

test("the published schedule is 0.5 / 0.5 / 0.25 percent of profit", () => {
  assert.equal(FEE_SCHEDULE.platformBps, 50);
  assert.equal(FEE_SCHEDULE.agentOwnerBps, 50);
  assert.equal(FEE_SCHEDULE.basketCreatorBps, 25);
  // 1.25% all in — and the contract refuses anything over 10%.
  assert.equal(scheduleTotalBps(), 125);
  assert.ok(BigInt(scheduleTotalBps()) < MAX_TOTAL_FEE_BPS);
});

test("fees come out of profit, never out of principal", () => {
  const result = split();
  assert.equal(result.grossProfitUnits, USDC(100));
  assert.equal(result.platformFeeUnits, USDC(0.5));
  assert.equal(result.agentOwnerFeeUnits, USDC(0.5));
  assert.equal(result.basketCreatorFeeUnits, USDC(0.25));
  assert.equal(result.totalFeeUnits, USDC(1.25));
  assert.equal(result.netProfitUnits, USDC(98.75));
  // The winner keeps every cent of what they staked.
  assert.ok(result.payoutUnits >= result.principalUnits);
  assert.equal(result.payoutUnits, USDC(198.75));
});

test("a trade with no basket charges only the two on-chain legs", () => {
  const result = split({ basketCreatorRecipient: null });
  assert.equal(result.basketCreatorFeeUnits, 0n);
  assert.equal(result.totalFeeUnits, USDC(1));
});

test("a trade with no agent attribution charges only the platform", () => {
  const result = split({ agentOwnerRecipient: null, basketCreatorRecipient: null });
  assert.equal(result.agentOwnerFeeUnits, 0n);
  assert.equal(result.totalFeeUnits, USDC(0.5));
});

test("using your own agent costs you no agent fee", () => {
  const result = split({ earner: AGENT_OWNER, basketCreatorRecipient: null });
  assert.equal(result.agentOwnerFeeUnits, 0n, "you do not pay yourself");
  assert.deepEqual(result.waived, ["agent_owner"]);
  // The platform leg still applies — that party is not you.
  assert.equal(result.platformFeeUnits, USDC(0.5));
});

test("profiting through a basket you composed costs you no basket fee", () => {
  const result = split({ earner: BASKET_CREATOR });
  assert.equal(result.basketCreatorFeeUnits, 0n);
  assert.deepEqual(result.waived, ["basket_creator"]);
  assert.equal(result.agentOwnerFeeUnits, USDC(0.5), "someone else's agent still earns");
});

test("your own agent inside your own basket waives both legs", () => {
  const result = split({
    earner: AGENT_OWNER,
    basketCreatorRecipient: AGENT_OWNER,
  });
  assert.equal(result.agentOwnerFeeUnits, 0n);
  assert.equal(result.basketCreatorFeeUnits, 0n);
  assert.deepEqual(result.waived, ["agent_owner", "basket_creator"]);
  assert.equal(result.totalFeeUnits, USDC(0.5));
});

test("the waiver is case-insensitive, because addresses arrive both ways", () => {
  const result = split({ earner: AGENT_OWNER.toUpperCase(), basketCreatorRecipient: null });
  assert.equal(result.agentOwnerFeeUnits, 0n, "a checksummed address is the same address");
});

test("a refund is returned whole, with no fee on any leg", () => {
  for (const outcome of ["draw", "unresolvable", "cancelled"] as const) {
    const result = split({ outcome });
    assert.equal(result.totalFeeUnits, 0n, `${outcome} must not be charged`);
    assert.equal(result.payoutUnits, result.principalUnits);
  }
});

test("a loser is charged nothing, because there is no profit to charge", () => {
  const result = split({ grossPayoutUnits: 0n });
  assert.equal(result.grossProfitUnits, 0n);
  assert.equal(result.totalFeeUnits, 0n);
  assert.equal(result.payoutUnits, 0n);
});

test("a payout that merely returns the stake is not profit", () => {
  const result = split({ grossPayoutUnits: USDC(100) });
  assert.equal(result.grossProfitUnits, 0n);
  assert.equal(result.totalFeeUnits, 0n);
});

test("rounding truncates in the participant's favour", () => {
  // 1 atomic unit of profit: every leg rounds down to zero rather than up to one.
  const result = split({ principalUnits: USDC(100), grossPayoutUnits: USDC(100) + 1n });
  assert.equal(result.grossProfitUnits, 1n);
  assert.equal(result.totalFeeUnits, 0n);
  assert.equal(result.netProfitUnits, 1n);
});

test("fees can never exceed the profit they are charged on", () => {
  for (const profit of [1n, 7n, 999n, USDC(0.01), USDC(3.33), USDC(1234.56)]) {
    const result = split({ principalUnits: USDC(10), grossPayoutUnits: USDC(10) + profit });
    assert.ok(result.totalFeeUnits <= result.grossProfitUnits, `profit ${profit}`);
    assert.ok(result.payoutUnits >= result.principalUnits, `winner kept principal at ${profit}`);
    assert.equal(
      result.netProfitUnits + result.totalFeeUnits,
      result.grossProfitUnits,
      "every atom is accounted for",
    );
  }
});

test("the zero address counts as no recipient, not as a recipient of nothing", () => {
  // It is what the contract stores for an unattributed market and what an unset
  // env resolves to. Charging a fee payable to nobody would take money off a
  // winner and burn it.
  const result = split({
    agentOwnerRecipient: "0x0000000000000000000000000000000000000000",
    basketCreatorRecipient: "0x0000000000000000000000000000000000000000",
  });
  assert.equal(result.agentOwnerFeeUnits, 0n);
  assert.equal(result.basketCreatorFeeUnits, 0n);
  assert.equal(result.totalFeeUnits, USDC(0.5), "only the platform leg remains");
  // Not a waiver: nobody was owed it, so nobody had it waived.
  assert.deepEqual(result.waived, []);
});
