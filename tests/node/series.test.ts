import assert from "node:assert/strict";
import test from "node:test";

import {
  MIN_SETTLEMENT_RULE_CHARS,
  bestOfStatus,
  buildSeries,
  findRoot,
  isRefundedOutcome,
  rematchReadiness,
  roundWinner,
  type RematchInheritance,
  type SeriesClaim,
} from "../../lib/series";

function claim(overrides: Partial<SeriesClaim> & { id: number }): SeriesClaim {
  return {
    parentId: 0,
    state: "resolved",
    winnerSide: "creator",
    createdAt: overrides.id * 1_000,
    ...overrides,
  };
}

/** A clean 3-round line: creator, challengers, creator. */
function line(): SeriesClaim[] {
  return [
    claim({ id: 1, parentId: 0, winnerSide: "creator" }),
    claim({ id: 2, parentId: 1, winnerSide: "challengers" }),
    claim({ id: 3, parentId: 2, winnerSide: "creator" }),
  ];
}

// ── Cycle safety: a read path must never hang ──────────────────────────────────

test("a self-parenting claim is its own root instead of looping", () => {
  const claims = [claim({ id: 5, parentId: 5 })];
  const byId = new Map(claims.map((c) => [c.id, c]));
  const result = findRoot(5, byId);
  assert.equal(result.rootId, 5);
  assert.equal(result.cycleDetected, true);
});

test("a parent cycle terminates and is reported", () => {
  // 1 -> 2 -> 3 -> 1. parentId is unvalidated on chain, so this is reachable.
  const claims = [
    claim({ id: 1, parentId: 3 }),
    claim({ id: 2, parentId: 1 }),
    claim({ id: 3, parentId: 2 }),
  ];
  const byId = new Map(claims.map((c) => [c.id, c]));
  const result = findRoot(2, byId);
  assert.equal(result.cycleDetected, true);
  assert.ok(result.rootId > 0);
});

test("buildSeries terminates on a cyclic chain and flags it", () => {
  const claims = [
    claim({ id: 1, parentId: 3 }),
    claim({ id: 2, parentId: 1 }),
    claim({ id: 3, parentId: 2 }),
  ];
  const series = buildSeries(2, claims);
  assert.equal(series.cycleDetected, true);
  // Every claim is still reported exactly once.
  assert.equal(new Set(series.rounds.map((r) => r.claimId)).size, series.rounds.length);
});

test("a parent that is not in the supplied set is treated as the root", () => {
  // The read-index may hold a window of claims, not the whole history.
  const series = buildSeries(2, [claim({ id: 2, parentId: 99 })]);
  assert.equal(series.rootId, 2);
  assert.equal(series.cycleDetected, false);
});

// ── Rounds and ordering ───────────────────────────────────────────────────────

test("a clean line numbers rounds from the root", () => {
  const series = buildSeries(3, line());
  assert.equal(series.rootId, 1);
  assert.deepEqual(
    series.rounds.map((r) => [r.claimId, r.round]),
    [
      [1, 1],
      [2, 2],
      [3, 3],
    ],
  );
  assert.equal(series.nextRound, 4);
});

test("the series is found from any member, not just the tail", () => {
  const fromMiddle = buildSeries(2, line());
  const fromTail = buildSeries(3, line());
  assert.equal(fromMiddle.rootId, fromTail.rootId);
  assert.equal(fromMiddle.rounds.length, fromTail.rounds.length);
});

test("siblings created in the same block still order deterministically", () => {
  // Same createdAt: id breaks the tie, so the line chosen does not flicker.
  const claims = [
    claim({ id: 1, parentId: 0 }),
    claim({ id: 7, parentId: 1, createdAt: 5_000 }),
    claim({ id: 4, parentId: 1, createdAt: 5_000 }),
  ];
  const a = buildSeries(1, claims);
  const b = buildSeries(1, [...claims].reverse());
  assert.deepEqual(a.rounds.map((r) => r.claimId), b.rounds.map((r) => r.claimId));
  assert.deepEqual(a.rounds.map((r) => r.claimId), [1, 4]);
  assert.deepEqual(a.branchRounds.map((r) => r.claimId), [7]);
});

test("a single claim with no parent is a one-round series", () => {
  const series = buildSeries(1, [claim({ id: 1 })]);
  assert.equal(series.rounds.length, 1);
  assert.equal(series.nextRound, 2);
});

// ── Branching ─────────────────────────────────────────────────────────────────

test("two rematches from one parent are reported as a branch", () => {
  // Parallel rematches are not one sequence, and the UI must not draw them as one.
  const series = buildSeries(1, [
    claim({ id: 1, parentId: 0 }),
    claim({ id: 2, parentId: 1, createdAt: 1_000 }),
    claim({ id: 3, parentId: 1, createdAt: 2_000 }),
  ]);
  assert.deepEqual(series.branchedAt, [1]);
  // One round per depth on the main line; the sibling is recorded separately.
  assert.equal(series.rounds.filter((r) => r.round === 2).length, 1);
  assert.deepEqual(series.branchRounds.map((r) => r.claimId), [3]);
});

test("an abandoned branch cannot pad the score", () => {
  // Anyone may rematch a settled parent, so scoring every branch would let someone
  // spawn rematches they expect to win and abandon the rest.
  const series = buildSeries(1, [
    claim({ id: 1, parentId: 0, state: "resolved", winnerSide: "creator" }),
    claim({ id: 2, parentId: 1, createdAt: 1_000, state: "resolved", winnerSide: "challengers" }),
    claim({ id: 3, parentId: 1, createdAt: 2_000, state: "resolved", winnerSide: "creator" }),
    claim({ id: 4, parentId: 1, createdAt: 3_000, state: "resolved", winnerSide: "creator" }),
  ]);
  assert.equal(series.creatorWins, 1);
  assert.equal(series.challengerWins, 1);
  assert.equal(series.branchRounds.length, 2);
});

test("the series follows the line the viewed claim is on", () => {
  // Viewing a later sibling must not drop it out of its own series.
  const claims = [
    claim({ id: 1, parentId: 0, state: "resolved", winnerSide: "creator" }),
    claim({ id: 2, parentId: 1, createdAt: 1_000, state: "resolved", winnerSide: "creator" }),
    claim({ id: 3, parentId: 1, createdAt: 2_000, state: "resolved", winnerSide: "challengers" }),
    claim({ id: 4, parentId: 3, createdAt: 3_000, state: "resolved", winnerSide: "challengers" }),
  ];
  const viewed = buildSeries(4, claims);
  assert.deepEqual(viewed.rounds.map((r) => r.claimId), [1, 3, 4]);
  assert.equal(viewed.challengerWins, 2);
  // From the other sibling, the other line is the series.
  assert.deepEqual(buildSeries(2, claims).rounds.map((r) => r.claimId), [1, 2]);
});

test("a straight line reports no branches", () => {
  assert.deepEqual(buildSeries(3, line()).branchedAt, []);
});

// ── Scoring: a refund is not a result ─────────────────────────────────────────

test("draws, unresolvable outcomes and cancellations score nothing", () => {
  for (const [state, winnerSide] of [
    ["resolved", "draw"],
    ["resolved", "unresolvable"],
    ["cancelled", ""],
  ] as const) {
    const c = claim({ id: 1, state, winnerSide });
    assert.equal(roundWinner(c), "none", `${state}/${winnerSide} must not score`);
    assert.equal(isRefundedOutcome(c), true);
  }
});

test("an unresolved claim scores nothing and is not a refund", () => {
  for (const state of ["open", "active"] as const) {
    const c = claim({ id: 1, state, winnerSide: "" });
    assert.equal(roundWinner(c), "none");
    assert.equal(isRefundedOutcome(c), false);
  }
});

test("the series score counts only decisive rounds", () => {
  const series = buildSeries(4, [
    claim({ id: 1, parentId: 0, winnerSide: "creator" }),
    claim({ id: 2, parentId: 1, state: "resolved", winnerSide: "draw" }),
    claim({ id: 3, parentId: 2, state: "cancelled", winnerSide: "" }),
    claim({ id: 4, parentId: 3, winnerSide: "creator" }),
  ]);
  assert.equal(series.creatorWins, 2);
  assert.equal(series.challengerWins, 0);
  assert.equal(series.refundedRounds, 2);
  // All four rounds are still shown.
  assert.equal(series.rounds.length, 4);
});

// ── Best-of ───────────────────────────────────────────────────────────────────

test("a best-of-3 is decided at 2-0 without playing round 3", () => {
  const series = buildSeries(2, [
    claim({ id: 1, parentId: 0, winnerSide: "creator" }),
    claim({ id: 2, parentId: 1, winnerSide: "creator" }),
  ]);
  const status = bestOfStatus(series, 3);
  assert.equal(status.target, 2);
  assert.equal(status.decided, true);
  assert.equal(status.leader, "creator");
});

test("a best-of-3 at 1-1 is undecided with one round left", () => {
  const status = bestOfStatus(buildSeries(2, [
    claim({ id: 1, parentId: 0, winnerSide: "creator" }),
    claim({ id: 2, parentId: 1, winnerSide: "challengers" }),
  ]), 3);
  assert.equal(status.decided, false);
  assert.equal(status.leader, "none");
  assert.equal(status.roundsRemaining, 1);
});

test("a best-of-5 needs three wins", () => {
  const status = bestOfStatus(buildSeries(3, [
    claim({ id: 1, parentId: 0, winnerSide: "challengers" }),
    claim({ id: 2, parentId: 1, winnerSide: "challengers" }),
    claim({ id: 3, parentId: 2, winnerSide: "creator" }),
  ]), 5);
  assert.equal(status.target, 3);
  assert.equal(status.decided, false);
  assert.equal(status.leader, "challengers");
  assert.equal(status.roundsRemaining, 2);
});

test("refunded rounds do not consume a best-of slot", () => {
  // Two draws must not silently end a best-of-3 nobody won.
  const series = buildSeries(2, [
    claim({ id: 1, parentId: 0, state: "resolved", winnerSide: "draw" }),
    claim({ id: 2, parentId: 1, state: "resolved", winnerSide: "unresolvable" }),
  ]);
  const status = bestOfStatus(series, 3);
  assert.equal(status.creatorWins, 0);
  assert.equal(status.challengerWins, 0);
  assert.equal(status.decided, false);
  assert.equal(status.roundsRemaining, 3, "all three decisive rounds are still to play");
});

// ── Inheritance ───────────────────────────────────────────────────────────────

function parent(overrides: Partial<RematchInheritance> = {}): RematchInheritance {
  return {
    question: "Will BTC close above $100,000 on 2026-05-25?",
    creatorPosition: "Yes",
    counterPosition: "No",
    resolutionUrl: "https://www.coingecko.com/en/coins/bitcoin",
    category: "crypto",
    marketType: "binary",
    oddsMode: "pool",
    challengerPayoutBps: 0,
    handicapLine: "",
    settlementRule: "Settle on CoinGecko's reported daily close in UTC.",
    maxChallengers: 1,
    isPrivate: false,
    ...overrides,
  };
}

test("a rematch always re-asks for the deadline and the stake", () => {
  // Both are meaningless copied from a settled market.
  const readiness = rematchReadiness(parent());
  assert.ok(readiness.needsReview.includes("deadline"));
  assert.ok(readiness.needsReview.includes("stake"));
  assert.equal(readiness.ready, true);
});

test("a thin settlement rule forces a correction step", () => {
  // Copying a vague rule reproduces the ambiguity that made round one contentious.
  const readiness = rematchReadiness(parent({ settlementRule: "the usual" }));
  assert.equal(readiness.ready, false);
  assert.ok(readiness.needsReview.includes("settlementRule"));
  assert.ok("the usual".length < MIN_SETTLEMENT_RULE_CHARS);
});

test("a missing or non-http source forces a correction step", () => {
  for (const url of ["", "coingecko.com", "ftp://x/y"]) {
    const readiness = rematchReadiness(parent({ resolutionUrl: url }));
    assert.equal(readiness.ready, false, `should review: '${url}'`);
    assert.ok(readiness.needsReview.includes("resolutionUrl"));
  }
});
