import assert from "node:assert/strict";
import test from "node:test";

import type { VSData } from "../../lib/contract";
import { buildSeriesView, hasSeries } from "../../lib/series-view";

function claim(
  id: number,
  parentId: number,
  state: VSData["state"],
  winnerSide: VSData["winner_side"] = "",
): VSData {
  return {
    id,
    creator: "0xcreator",
    opponent: "0xopponent",
    question: `round for ${id}`,
    creator_position: "yes",
    opponent_position: "no",
    resolution_url: "",
    stake_amount: 5,
    deadline: 0,
    state,
    winner: "",
    resolution_summary: "",
    category: "crypto",
    parent_id: parentId,
    winner_side: winnerSide,
    created_at: id,
  };
}

test("a lone market is not a series", () => {
  const view = buildSeriesView(1, [claim(1, 0, "resolved", "creator")]);
  assert.equal(hasSeries(view), false);
  assert.equal(view.rows.length, 1);
});

test("a chain scores each decided round", () => {
  const view = buildSeriesView(3, [
    claim(1, 0, "resolved", "creator"),
    claim(2, 1, "resolved", "challengers"),
    claim(3, 2, "resolved", "creator"),
  ]);
  assert.equal(hasSeries(view), true);
  assert.equal(view.scoreLabel, "2-1");
  assert.equal(view.leader, "creator");
  assert.deepEqual(view.rows.map((r) => r.round), [1, 2, 3]);
});

test("the round number comes from the chain, not the array order", () => {
  // The chain arrives in fetch order; using the index would renumber rounds.
  const view = buildSeriesView(3, [
    claim(3, 2, "resolved", "creator"),
    claim(1, 0, "resolved", "creator"),
    claim(2, 1, "resolved", "challengers"),
  ]);
  assert.deepEqual(view.rows.map((r) => [r.claim.id, r.round]), [
    [1, 1],
    [2, 2],
    [3, 3],
  ]);
});

test("a refund is shown but not scored", () => {
  const view = buildSeriesView(2, [
    claim(1, 0, "resolved", "creator"),
    claim(2, 1, "resolved", "draw"),
  ]);
  assert.equal(view.scoreLabel, "1-0");
  assert.equal(view.refundedRounds, 1);
  assert.equal(view.rows[1].refunded, true);
  assert.equal(view.rows[1].winner, "none");
});

test("a cancelled round refunds rather than handing a walkover", () => {
  const view = buildSeriesView(2, [
    claim(1, 0, "resolved", "challengers"),
    claim(2, 1, "cancelled"),
  ]);
  assert.equal(view.scoreLabel, "0-1");
  assert.equal(view.rows[1].refunded, true);
});

test("an unresolved round is neither won nor refunded", () => {
  const view = buildSeriesView(2, [
    claim(1, 0, "resolved", "creator"),
    claim(2, 1, "accepted"),
  ]);
  assert.equal(view.rows[1].decided, false);
  assert.equal(view.rows[1].refunded, false);
  assert.equal(view.scoreLabel, "1-0");
});

test("an accepted market is active, not an unknown state", () => {
  // VSData says "accepted" where the series module says "active".
  const view = buildSeriesView(1, [claim(1, 0, "accepted")]);
  assert.equal(view.rows[0].decided, false);
  assert.equal(view.scoreLabel, null);
});

test("a level series has no leader", () => {
  const view = buildSeriesView(2, [
    claim(1, 0, "resolved", "creator"),
    claim(2, 1, "resolved", "challengers"),
  ]);
  assert.equal(view.scoreLabel, "1-1");
  assert.equal(view.leader, "none");
});

test("an undecided series shows no score at all", () => {
  // "0-0" reads as a played draw rather than as nothing having happened.
  const view = buildSeriesView(2, [claim(1, 0, "resolved", "draw"), claim(2, 1, "open")]);
  assert.equal(view.scoreLabel, null);
  assert.equal(view.leader, "none");
});

test("the current market is marked so the card can highlight it", () => {
  const view = buildSeriesView(2, [claim(1, 0, "resolved", "creator"), claim(2, 1, "open")]);
  assert.deepEqual(view.rows.map((r) => r.isCurrent), [false, true]);
});

test("a self-parenting claim is reported, not rendered as a loop", () => {
  const view = buildSeriesView(1, [claim(1, 1, "resolved", "creator")]);
  assert.equal(view.cycleDetected, true);
  assert.equal(view.rows.length, 1);
});

test("a branched chain is flagged so the UI can call it a tree, not a line", () => {
  const view = buildSeriesView(2, [
    claim(1, 0, "resolved", "creator"),
    claim(2, 1, "resolved", "creator"),
    claim(3, 1, "resolved", "challengers"),
  ]);
  assert.equal(view.branched, true);
  assert.equal(view.branchCount, 1);
  // The viewed claim's own line is the series, and the sibling does not score.
  assert.deepEqual(view.rows.map((r) => r.claim.id), [1, 2]);
  assert.equal(view.scoreLabel, "2-0");
});

test("the next round number continues the chain", () => {
  const view = buildSeriesView(2, [
    claim(1, 0, "resolved", "creator"),
    claim(2, 1, "resolved", "challengers"),
  ]);
  assert.equal(view.nextRound, 3);
});

test("a missing ancestor does not renumber the rounds around it", () => {
  // The read-index serves a window, so round 1 can be absent on chain-old series.
  const view = buildSeriesView(3, [claim(2, 1, "resolved", "creator"), claim(3, 2, "open")]);
  const rounds = view.rows.map((r) => r.round);
  // Whatever the numbering starts at, it stays consecutive and ordered.
  assert.equal(rounds.length, 2);
  assert.equal(rounds[1], rounds[0] + 1);
});
