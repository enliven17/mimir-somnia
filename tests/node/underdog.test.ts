import assert from "node:assert/strict";
import test from "node:test";

import {
  UNDERDOG_MIN_IMBALANCE_BPS,
  UNDERDOG_MIN_POT_USDC,
  assessUnderdog,
  compareByUpside,
  isChallengerUnderdog,
} from "../../lib/underdog";
import type { VSData } from "../../lib/contract";

function vs(overrides: Partial<VSData> & { id: number }): VSData {
  return {
    creator: "0x00000000000000000000000000000000000000a1",
    opponent: "0x0000000000000000000000000000000000000000",
    question: "Q",
    creator_position: "Yes",
    opponent_position: "No",
    resolution_url: "https://example.com",
    stake_amount: 10,
    deadline: 1_800_000_000,
    state: "open",
    winner: "0x0000000000000000000000000000000000000000",
    resolution_summary: "",
    category: "crypto",
    creator_stake: 10,
    total_challenger_stake: 0,
    market_type: "binary",
    odds_mode: "pool",
    max_challengers: 10,
    ...overrides,
  } as VSData;
}

// ── When there is no shape to report ──────────────────────────────────────────

test("a near-empty market has no underdog side", () => {
  // Below the pot floor the asymmetry is noise and a badge would be meaningless.
  const signal = assessUnderdog(vs({ id: 1, creator_stake: 1, total_challenger_stake: 0 }));
  assert.equal(signal.isUnderdog, false);
  assert.equal(signal.minoritySide, null);
  assert.ok(UNDERDOG_MIN_POT_USDC > 0);
});

test("a balanced pool is not an underdog opportunity", () => {
  const signal = assessUnderdog(vs({ id: 1, creator_stake: 50, total_challenger_stake: 50 }));
  assert.equal(signal.isUnderdog, false);
  assert.equal(signal.imbalanceBps, 0);
  assert.equal(signal.minoritySide, null);
});

test("a mildly skewed pool stays below the badge threshold", () => {
  // 55/45 is not worth a badge.
  const signal = assessUnderdog(vs({ id: 1, creator_stake: 55, total_challenger_stake: 45 }));
  assert.ok(signal.imbalanceBps < UNDERDOG_MIN_IMBALANCE_BPS);
  assert.equal(signal.isUnderdog, false);
});

// ── Duel and fixed odds have no underdog side ─────────────────────────────────

test("a duel has no underdog side — stakes are equal by definition", () => {
  const signal = assessUnderdog(
    vs({ id: 1, max_challengers: 1, creator_stake: 50, total_challenger_stake: 10 }),
  );
  assert.equal(signal.isUnderdog, false);
});

test("fixed odds has no underdog side — it posts its own multiple", () => {
  const signal = assessUnderdog(
    vs({ id: 1, odds_mode: "fixed", creator_stake: 90, total_challenger_stake: 10 }),
  );
  assert.equal(signal.isUnderdog, false);
});

// ── The real signal ───────────────────────────────────────────────────────────

test("a thin challenger side is flagged and names both sides", () => {
  const signal = assessUnderdog(vs({ id: 1, creator_stake: 90, total_challenger_stake: 10 }));
  assert.equal(signal.isUnderdog, true);
  assert.equal(signal.minoritySide, "challengers");
  assert.equal(signal.crowdedSide, "creator");
  assert.equal(isChallengerUnderdog(signal), true);
});

test("a thin CREATOR side is lopsided but not badgeable", () => {
  // A browsing user cannot take the creator's side, so badging it would mislead.
  const signal = assessUnderdog(vs({ id: 1, creator_stake: 10, total_challenger_stake: 90 }));
  assert.equal(signal.isUnderdog, true);
  assert.equal(signal.minoritySide, "creator");
  assert.equal(isChallengerUnderdog(signal), false);
});

test("upside is quoted for a named probe stake, because size dilutes it", () => {
  // Joining a 10 USDC challenger pool against a 90 creator stake:
  // a 2 USDC stake takes a larger share of the creator stake than a 50 one.
  const market = vs({ id: 1, creator_stake: 90, total_challenger_stake: 10 });
  const small = assessUnderdog(market, 2).challengerUpsideBps;
  const large = assessUnderdog(market, 50).challengerUpsideBps;
  assert.ok(small > large, "a large stake dilutes its own payout");
});

test("the quoted return multiple matches the upside", () => {
  const signal = assessUnderdog(vs({ id: 1, creator_stake: 90, total_challenger_stake: 10 }), 2);
  // 2 USDC into a 12 pool against 90 → share = floor(2*90/12) = 15, total 17.
  assert.equal(signal.challengerReturnMultiple, 8.5);
  assert.equal(signal.challengerUpsideBps, 75_000);
});

test("the crowded side reports thin upside", () => {
  // Joining the side that already holds most of the money.
  const signal = assessUnderdog(vs({ id: 1, creator_stake: 10, total_challenger_stake: 90 }), 2);
  assert.ok(signal.challengerUpsideBps < 5_000);
});

// ── Sorting ───────────────────────────────────────────────────────────────────

test("sorting by upside puts the thinnest joinable side first", () => {
  const thin = vs({ id: 1, creator_stake: 90, total_challenger_stake: 10 });
  const even = vs({ id: 2, creator_stake: 50, total_challenger_stake: 50 });
  const crowded = vs({ id: 3, creator_stake: 10, total_challenger_stake: 90 });
  const sorted = [even, crowded, thin].sort((a, b) => compareByUpside(a, b));
  assert.deepEqual(
    sorted.map((v) => v.id),
    [1, 2, 3],
  );
});

test("equal upside falls back to id so the order is stable", () => {
  const a = vs({ id: 1, creator_stake: 50, total_challenger_stake: 50 });
  const b = vs({ id: 2, creator_stake: 50, total_challenger_stake: 50 });
  assert.equal(compareByUpside(a, b), 1);
  assert.equal(compareByUpside(b, a), -1);
});

test("markets with no shape sort last rather than crashing", () => {
  const empty = vs({ id: 5, creator_stake: 0, total_challenger_stake: 0 });
  const thin = vs({ id: 1, creator_stake: 90, total_challenger_stake: 10 });
  const sorted = [empty, thin].sort((a, b) => compareByUpside(a, b));
  assert.deepEqual(
    sorted.map((v) => v.id),
    [1, 5],
  );
});
