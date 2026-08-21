import assert from "node:assert/strict";
import test from "node:test";

import {
  DIMENSION_FLOORS,
  PREFLIGHT_DIMENSIONS,
  isPreflightDimension,
  scorePreflight,
  type DimensionOpinion,
} from "../../lib/market-creator/preflight-score";

function opinion(slug: string, overrides: Partial<DimensionOpinion> = {}): DimensionOpinion {
  return {
    slug,
    confidence: 80,
    scores: {
      resolutionClarity: 85,
      sourceIndependence: 80,
      liquidityFit: 75,
      bestMode: 70,
    },
    ...overrides,
  };
}

const PANEL = [opinion("a"), opinion("b"), opinion("c")];

test("a clean panel admits the market", () => {
  const verdict = scorePreflight(PANEL);
  assert.equal(verdict.autonomousOk, true);
  assert.equal(verdict.blockedBy, undefined);
  assert.equal(verdict.failing.length, 0);
});

// ── The aggregate is the minimum ───────────────────────────────────────────────

test("the aggregate is the weakest dimension, not the average", () => {
  // Averaging lets one fatal dimension hide behind three good ones.
  const verdict = scorePreflight([
    opinion("a", {
      scores: { resolutionClarity: 20, sourceIndependence: 100, liquidityFit: 100, bestMode: 100 },
    }),
  ]);
  assert.equal(verdict.aggregate, 20);
});

test("a market nobody can settle is refused however good its sources are", () => {
  const verdict = scorePreflight([
    opinion("a", {
      scores: { resolutionClarity: 30, sourceIndependence: 100, liquidityFit: 100, bestMode: 100 },
    }),
  ]);
  assert.equal(verdict.autonomousOk, false);
  assert.deepEqual(verdict.failing, ["resolutionClarity"]);
  assert.match(verdict.blockedBy ?? "", /resolutionClarity/);
});

test("resolution clarity has the strictest floor", () => {
  // An ambiguous rule produces a dispute no amount of sourcing repairs.
  for (const dimension of PREFLIGHT_DIMENSIONS) {
    if (dimension === "resolutionClarity") continue;
    assert.ok(
      DIMENSION_FLOORS.resolutionClarity > DIMENSION_FLOORS[dimension],
      `${dimension} floor is not below resolutionClarity`,
    );
  }
});

test("each dimension can veto on its own", () => {
  for (const dimension of PREFLIGHT_DIMENSIONS) {
    const scores = { resolutionClarity: 95, sourceIndependence: 95, liquidityFit: 95, bestMode: 95 };
    scores[dimension] = DIMENSION_FLOORS[dimension] - 1;
    const verdict = scorePreflight([opinion("a", { scores })]);
    assert.equal(verdict.autonomousOk, false, `${dimension} did not veto`);
    assert.deepEqual(verdict.failing, [dimension]);
  }
});

test("a score exactly at the floor passes", () => {
  const scores = {
    resolutionClarity: DIMENSION_FLOORS.resolutionClarity,
    sourceIndependence: DIMENSION_FLOORS.sourceIndependence,
    liquidityFit: DIMENSION_FLOORS.liquidityFit,
    bestMode: DIMENSION_FLOORS.bestMode,
  };
  assert.equal(scorePreflight([opinion("a", { scores })]).autonomousOk, true);
});

// ── Missing dimensions ─────────────────────────────────────────────────────────

test("an unscored dimension blocks rather than passing by default", () => {
  const verdict = scorePreflight([
    opinion("a", { scores: { resolutionClarity: 90, sourceIndependence: 90, liquidityFit: 90 } }),
  ]);
  assert.deepEqual(verdict.unscored, ["bestMode"]);
  assert.equal(verdict.aggregate, null);
  assert.equal(verdict.autonomousOk, false);
  assert.match(verdict.blockedBy ?? "", /unscored: bestMode/);
});

test("one persona abstaining on a dimension does not make it unscored", () => {
  const verdict = scorePreflight([
    opinion("a"),
    opinion("b", { scores: { resolutionClarity: 90, sourceIndependence: 90, liquidityFit: 90 } }),
  ]);
  assert.equal(verdict.unscored.length, 0);
  assert.equal(verdict.dimensions.bestMode.voters, 1);
});

test("an empty panel is a block, not a pass", () => {
  const verdict = scorePreflight([]);
  assert.equal(verdict.autonomousOk, false);
  assert.equal(verdict.blockedBy, "no preflight opinions");
  assert.equal(verdict.aggregate, null);
});

test("a non-numeric score is ignored rather than coerced", () => {
  const verdict = scorePreflight([
    opinion("a", {
      scores: {
        resolutionClarity: Number.NaN,
        sourceIndependence: 90,
        liquidityFit: 90,
        bestMode: 90,
      },
    }),
  ]);
  assert.equal(verdict.dimensions.resolutionClarity.voters, 0);
  assert.deepEqual(verdict.unscored, ["resolutionClarity"]);
});

// ── Weighting ─────────────────────────────────────────────────────────────────

test("confidence weights a persona's score within a dimension", () => {
  const verdict = scorePreflight([
    opinion("sure", { confidence: 100, scores: { resolutionClarity: 100 } }),
    opinion("unsure", { confidence: 10, scores: { resolutionClarity: 0 } }),
  ]);
  assert.ok((verdict.dimensions.resolutionClarity.score ?? 0) > 85);
});

test("a zero-confidence voter still counts as having looked", () => {
  // "everyone scored it, nobody was sure" must not read as "nobody looked".
  const verdict = scorePreflight([opinion("a", { confidence: 0, scores: { liquidityFit: 40 } })]);
  assert.equal(verdict.dimensions.liquidityFit.voters, 1);
  assert.equal(verdict.dimensions.liquidityFit.score, 40);
});

test("out-of-range scores and confidences are clamped", () => {
  const verdict = scorePreflight([
    opinion("a", { confidence: 500, scores: { resolutionClarity: 900, sourceIndependence: -50 } }),
  ]);
  assert.equal(verdict.dimensions.resolutionClarity.score, 100);
  assert.equal(verdict.dimensions.sourceIndependence.score, 0);
});

// ── Mode selection ────────────────────────────────────────────────────────────

test("a strict majority picks the mode", () => {
  const verdict = scorePreflight([
    opinion("a", { suggestedMode: "pool" }),
    opinion("b", { suggestedMode: "pool" }),
    opinion("c", { suggestedMode: "duel" }),
  ]);
  assert.equal(verdict.suggestedMode, "pool");
  assert.equal(verdict.modeContested, false);
});

test("a plurality is not enough", () => {
  // Opening a market in a mode most of the panel did not pick is how a fixed-odds
  // market gets created because three personas wanted three things.
  const verdict = scorePreflight([
    opinion("a", { suggestedMode: "pool" }),
    opinion("b", { suggestedMode: "duel" }),
    opinion("c", { suggestedMode: "fixed_odds" }),
  ]);
  assert.equal(verdict.suggestedMode, null);
  assert.equal(verdict.modeContested, true);
  assert.equal(verdict.autonomousOk, false);
});

test("an even split is contested, not resolved by order", () => {
  const votes: DimensionOpinion[] = [
    opinion("a", { suggestedMode: "duel" }),
    opinion("b", { suggestedMode: "pool" }),
  ];
  const forward = scorePreflight(votes);
  const reversed = scorePreflight([...votes].reverse());
  assert.equal(forward.suggestedMode, null);
  assert.equal(reversed.suggestedMode, null);
  assert.equal(forward.modeContested, true);
});

test("no persona expressing a view is not a contest", () => {
  const verdict = scorePreflight(PANEL);
  assert.equal(verdict.suggestedMode, null);
  assert.equal(verdict.modeContested, false);
  assert.equal(verdict.autonomousOk, true);
});

test("the panel preferring a different mode blocks autonomous publishing", () => {
  const verdict = scorePreflight(
    [
      opinion("a", { suggestedMode: "duel" }),
      opinion("b", { suggestedMode: "duel" }),
      opinion("c", { suggestedMode: "pool" }),
    ],
    "pool",
  );
  assert.equal(verdict.suggestedMode, "duel");
  assert.equal(verdict.autonomousOk, false);
  assert.match(verdict.blockedBy ?? "", /prefers duel over the requested pool/);
});

test("the panel agreeing with the requested mode does not block", () => {
  const verdict = scorePreflight(
    [opinion("a", { suggestedMode: "pool" }), opinion("b", { suggestedMode: "pool" })],
    "pool",
  );
  assert.equal(verdict.autonomousOk, true);
});

// ── Blocker ordering ──────────────────────────────────────────────────────────

test("the first blocker reported is the actionable one", () => {
  // An unscored dimension is a gap in the review; naming a mode disagreement first
  // would send someone to fix the wrong thing.
  const verdict = scorePreflight(
    [opinion("a", { scores: { resolutionClarity: 20 }, suggestedMode: "duel" })],
    "pool",
  );
  assert.match(verdict.blockedBy ?? "", /unscored/);
});

test("dimension names are validated", () => {
  for (const dimension of PREFLIGHT_DIMENSIONS) assert.equal(isPreflightDimension(dimension), true);
  assert.equal(isPreflightDimension("vibes"), false);
});
