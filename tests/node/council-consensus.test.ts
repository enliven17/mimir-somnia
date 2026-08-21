import assert from "node:assert/strict";
import test from "node:test";

import { councilConsensus, type TrackVote } from "../../lib/council/consensus";

function vote(
  slug: string,
  track: TrackVote["track"],
  verdict: TrackVote["verdict"],
  confidenceBps = 8_000,
): TrackVote {
  return { slug, track, verdict, confidenceBps };
}

test("each track is tallied separately", () => {
  const report = councilConsensus([
    vote("optimist", "classic", "creator"),
    vote("doomer", "classic", "creator"),
    vote("taleb", "philosopher", "challengers"),
  ]);
  assert.equal(report.classic.leading, "creator");
  assert.equal(report.philosopher.leading, "challengers");
  assert.equal(report.classic.voters, 2);
  assert.equal(report.philosopher.voters, 1);
});

test("disagreement between the tracks is reported, not averaged away", () => {
  // This is the entire reason for a second jury.
  const report = councilConsensus([
    vote("optimist", "classic", "creator"),
    vote("taleb", "philosopher", "challengers"),
  ]);
  assert.equal(report.tracksDisagree, true);
});

test("agreement is not called disagreement", () => {
  const report = councilConsensus([
    vote("optimist", "classic", "creator"),
    vote("taleb", "philosopher", "creator"),
  ]);
  assert.equal(report.tracksDisagree, false);
});

test("the combined tally weights the tracks equally, not by head count", () => {
  // Nine philosophers must not outvote one classic persona simply by being nine.
  const votes: TrackVote[] = [vote("optimist", "classic", "creator", 10_000)];
  for (let i = 0; i < 9; i += 1) {
    votes.push(vote(`p${i}`, "philosopher", "challengers", 10_000));
  }
  const report = councilConsensus(votes);
  assert.equal(report.combined.weightBps.creator, 5_000);
  assert.equal(report.combined.weightBps.challengers, 5_000);
  // An exact split has no leader rather than an arbitrary one.
  assert.equal(report.combined.leading, null);
});

test("adding a philosopher who agrees with its own track does not move the combined verdict", () => {
  const base = councilConsensus([
    vote("optimist", "classic", "creator", 10_000),
    vote("taleb", "philosopher", "challengers", 10_000),
  ]);
  const grown = councilConsensus([
    vote("optimist", "classic", "creator", 10_000),
    vote("taleb", "philosopher", "challengers", 10_000),
    vote("munger", "philosopher", "challengers", 10_000),
  ]);
  assert.deepEqual(grown.combined.weightBps, base.combined.weightBps);
});

test("a single-track vote is flagged rather than reported as agreement", () => {
  const report = councilConsensus([vote("optimist", "classic", "creator")]);
  assert.equal(report.singleTrackOnly, true);
  assert.equal(report.tracksDisagree, false);
  // The combined tally still reflects the one track that voted.
  assert.equal(report.combined.leading, "creator");
});

// ── Abstentions ───────────────────────────────────────────────────────────────

test("an abstention is counted but carries no confidence weight", () => {
  // A jury that all abstained must not report a confident "abstain" verdict
  // competing with real positions.
  const report = councilConsensus([
    vote("lao-tzu", "philosopher", "abstain", 10_000),
    vote("taleb", "philosopher", "creator", 5_000),
  ]);
  assert.equal(report.philosopher.abstentions, 1);
  assert.equal(report.philosopher.counts.abstain, 1);
  assert.equal(report.philosopher.weightBps.abstain, 0);
  assert.equal(report.philosopher.leading, "creator");
});

test("a fully abstaining jury has no leading verdict", () => {
  const report = councilConsensus([
    vote("lao-tzu", "philosopher", "abstain"),
    vote("aurelius", "philosopher", "abstain"),
  ]);
  assert.equal(report.philosopher.leading, null);
  assert.equal(report.philosopher.voters, 2);
  assert.equal(report.philosopher.abstentions, 2);
});

test("mass abstention is distinguishable from a split", () => {
  const abstained = councilConsensus([
    vote("a", "classic", "abstain"),
    vote("b", "classic", "abstain"),
  ]);
  const split = councilConsensus([
    vote("a", "classic", "creator", 5_000),
    vote("b", "classic", "challengers", 5_000),
  ]);
  assert.equal(abstained.classic.abstentions, 2);
  assert.equal(split.classic.abstentions, 0);
  // Both have no leader, but for different reasons the counts make visible.
  assert.equal(abstained.classic.leading, null);
  assert.equal(split.classic.leading, null);
});

// ── Weighting ─────────────────────────────────────────────────────────────────

test("confidence weights a vote within its track", () => {
  const report = councilConsensus([
    vote("a", "classic", "creator", 9_000),
    vote("b", "classic", "challengers", 1_000),
  ]);
  assert.equal(report.classic.leading, "creator");
  assert.equal(report.classic.weightBps.creator, 9_000);
});

test("confidence outside 0..10000 is clamped rather than trusted", () => {
  const report = councilConsensus([
    vote("a", "classic", "creator", 999_999),
    vote("b", "classic", "challengers", -50),
  ]);
  assert.equal(report.classic.weightBps.creator, 10_000);
  assert.equal(report.classic.weightBps.challengers, 0);
});

test("a jury of zero-confidence voters has no leader instead of a random one", () => {
  const report = councilConsensus([
    vote("a", "classic", "creator", 0),
    vote("b", "classic", "challengers", 0),
  ]);
  assert.equal(report.classic.leading, null);
  assert.equal(report.classic.voters, 2);
});

test("an empty jury tallies to nothing rather than throwing", () => {
  const report = councilConsensus([]);
  assert.equal(report.combined.leading, null);
  assert.equal(report.combined.voters, 0);
  assert.equal(report.singleTrackOnly, true);
});

test("unresolvable is a first-class verdict, not folded into abstain", () => {
  // "the rule cannot settle this" is a finding; "I decline" is not.
  const report = councilConsensus([
    vote("a", "philosopher", "unresolvable", 9_000),
    vote("b", "philosopher", "abstain", 9_000),
  ]);
  assert.equal(report.philosopher.leading, "unresolvable");
  assert.equal(report.philosopher.counts.unresolvable, 1);
  assert.equal(report.philosopher.counts.abstain, 1);
});
