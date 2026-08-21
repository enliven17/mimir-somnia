import assert from "node:assert/strict";
import test from "node:test";

import type { ContextSource, MarketContextPack, TrustTier } from "../../lib/research/context-pack";
import { decideSourceFallback, type SourceProbe } from "../../lib/research/source-fallback";

const PRIMARY_HASH = "0x" + "aa".repeat(32);
const CORROB_HASH = "0x" + "bb".repeat(32);
const OTHER_HASH = "0x" + "cc".repeat(32);

function source(
  url: string,
  contentHash: string,
  trustTier: TrustTier = "corroborating",
): ContextSource {
  return {
    url,
    domain: new URL(url).hostname,
    trustTier,
    capturedAt: 1_000,
    contentHash,
    excerpt: "the number was 42",
  };
}

function pack(overrides: Partial<MarketContextPack> = {}): MarketContextPack {
  return {
    packVersion: 1,
    claim: "the number will exceed 40",
    creatorPosition: "yes",
    counterPosition: "no",
    subjectType: "binary",
    category: "crypto",
    entities: ["number"],
    deadline: 2_000,
    resolution: {
      rule: "read the number from the primary source after the deadline",
      timezone: "UTC",
      edgeCases: [],
    },
    primarySource: source("https://primary.example/report", PRIMARY_HASH, "primary"),
    corroboratingSources: [source("https://mirror.example/report", CORROB_HASH)],
    confidenceBps: 8_000,
    unresolvedQuestions: [],
    createdAt: 500,
    revision: 0,
    ...overrides,
  };
}

function probe(url: string, overrides: Partial<SourceProbe> = {}): SourceProbe {
  return { url, available: true, ...overrides };
}

// ── Rule 1: intact ────────────────────────────────────────────────────────────

test("an intact primary source settles cleanly", () => {
  const outcome = decideSourceFallback(pack(), [
    probe("https://primary.example/report", { contentHash: PRIMARY_HASH }),
  ]);
  assert.equal(outcome.decision, "settle_primary");
  assert.equal(outcome.citedUrl, "https://primary.example/report");
  assert.equal(outcome.degraded, false);
});

test("hash comparison ignores case", () => {
  const outcome = decideSourceFallback(pack(), [
    probe("https://primary.example/report", { contentHash: PRIMARY_HASH.toUpperCase() }),
  ]);
  assert.equal(outcome.decision, "settle_primary");
});

// ── Rule 2: changed content ───────────────────────────────────────────────────

test("a primary whose content changed is not silently accepted", () => {
  // It may have been corrected, back-dated, or tampered with. Settling on it would
  // decide the market on a number nobody can verify against the capture.
  const outcome = decideSourceFallback(pack(), [
    probe("https://primary.example/report", { contentHash: OTHER_HASH }),
    probe("https://mirror.example/report", { available: false, detail: "404" }),
  ]);
  assert.equal(outcome.decision, "unresolvable");
  assert.match(outcome.reason, /changed since capture/);
});

test("a changed primary settles when a corroborating source still agrees", () => {
  const outcome = decideSourceFallback(pack(), [
    probe("https://primary.example/report", { contentHash: OTHER_HASH }),
    probe("https://mirror.example/report", { contentHash: CORROB_HASH }),
  ]);
  assert.equal(outcome.decision, "settle_corroborated");
  assert.equal(outcome.citedUrl, "https://mirror.example/report");
  assert.equal(outcome.degraded, true);
});

test("a corroborating source that ALSO changed is not corroboration", () => {
  // Two unknowns are not a confirmation.
  const outcome = decideSourceFallback(pack(), [
    probe("https://primary.example/report", { contentHash: OTHER_HASH }),
    probe("https://mirror.example/report", { contentHash: OTHER_HASH }),
  ]);
  assert.equal(outcome.decision, "unresolvable");
});

test("an unverified source can never corroborate a changed primary", () => {
  // It is exactly the kind of source somebody could stand up to settle a market
  // their way.
  const outcome = decideSourceFallback(
    pack({ corroboratingSources: [source("https://rando.example/x", CORROB_HASH, "unverified")] }),
    [
      probe("https://primary.example/report", { contentHash: OTHER_HASH }),
      probe("https://rando.example/x", { contentHash: CORROB_HASH }),
    ],
  );
  assert.equal(outcome.decision, "unresolvable");
});

// ── Rule 3: unavailable primary ───────────────────────────────────────────────

test("an unavailable primary falls back to a verified corroborating source", () => {
  const outcome = decideSourceFallback(pack(), [
    probe("https://primary.example/report", { available: false, detail: "404" }),
    probe("https://mirror.example/report", { contentHash: CORROB_HASH }),
  ]);
  assert.equal(outcome.decision, "settle_fallback");
  assert.equal(outcome.citedUrl, "https://mirror.example/report");
  assert.equal(outcome.degraded, true);
  assert.match(outcome.reason, /404/);
});

test("a fallback that is available but changed is no better than a changed primary", () => {
  const outcome = decideSourceFallback(pack(), [
    probe("https://primary.example/report", { available: false, detail: "410 gone" }),
    probe("https://mirror.example/report", { contentHash: OTHER_HASH }),
  ]);
  assert.equal(outcome.decision, "unresolvable");
});

test("fallback picks a primary-tier stand-in before a corroborating one", () => {
  const outcome = decideSourceFallback(
    pack({
      corroboratingSources: [
        source("https://second.example/x", CORROB_HASH, "corroborating"),
        source("https://official.example/x", CORROB_HASH, "primary"),
      ],
    }),
    [
      probe("https://primary.example/report", { available: false }),
      probe("https://second.example/x", { contentHash: CORROB_HASH }),
      probe("https://official.example/x", { contentHash: CORROB_HASH }),
    ],
  );
  assert.equal(outcome.citedUrl, "https://official.example/x");
});

test("two equal-tier fallbacks are chosen deterministically", () => {
  const sources = [
    source("https://b.example/x", CORROB_HASH),
    source("https://a.example/x", CORROB_HASH),
  ];
  const probes = [
    probe("https://primary.example/report", { available: false }),
    probe("https://a.example/x", { contentHash: CORROB_HASH }),
    probe("https://b.example/x", { contentHash: CORROB_HASH }),
  ];
  const first = decideSourceFallback(pack({ corroboratingSources: sources }), probes);
  const second = decideSourceFallback(pack({ corroboratingSources: [...sources].reverse() }), probes);
  assert.equal(first.citedUrl, second.citedUrl);
  assert.equal(first.citedUrl, "https://a.example/x");
});

test("a primary that was never probed is treated as unavailable, not as intact", () => {
  // A missing probe is missing information; assuming health would settle a market
  // on evidence nobody looked at.
  const outcome = decideSourceFallback(pack(), []);
  assert.equal(outcome.decision, "unresolvable");
});

// ── Rule 4: void vs unresolvable ──────────────────────────────────────────────

test("a declared void rule is applied when nothing is usable", () => {
  const outcome = decideSourceFallback(
    pack({
      resolution: {
        rule: "r",
        timezone: "UTC",
        edgeCases: [],
        voidRule: "void if the report is not published",
      },
    }),
    [probe("https://primary.example/report", { available: false, detail: "404" })],
  );
  assert.equal(outcome.decision, "void_per_rule");
  assert.equal(outcome.citedUrl, null);
});

test("an undeclared void rule is unresolvable, not a default void", () => {
  // Inventing a void rule at settlement time is deciding the market after the fact.
  const outcome = decideSourceFallback(pack(), [
    probe("https://primary.example/report", { available: false }),
  ]);
  assert.equal(outcome.decision, "unresolvable");
  assert.match(outcome.reason, /no void rule was declared/);
});

test("a blank void rule does not count as declared", () => {
  const outcome = decideSourceFallback(
    pack({ resolution: { rule: "r", timezone: "UTC", edgeCases: [], voidRule: "   " } }),
    [probe("https://primary.example/report", { available: false })],
  );
  assert.equal(outcome.decision, "unresolvable");
});

// ── Audit trail ───────────────────────────────────────────────────────────────

test("every probed source is recorded with whether its hash matched", () => {
  const outcome = decideSourceFallback(pack(), [
    probe("https://primary.example/report", { contentHash: OTHER_HASH }),
    probe("https://mirror.example/report", { contentHash: CORROB_HASH }),
  ]);
  assert.deepEqual(outcome.probed, [
    { url: "https://primary.example/report", available: true, hashMatched: false },
    { url: "https://mirror.example/report", available: true, hashMatched: true },
  ]);
});

test("an unavailable source records a null hash match, not false", () => {
  // "we could not check" is different from "it did not match".
  const outcome = decideSourceFallback(pack(), [
    probe("https://primary.example/report", { available: false, detail: "timeout" }),
  ]);
  assert.equal(outcome.probed[0].hashMatched, null);
});

test("a degraded settlement is always flagged", () => {
  const clean = decideSourceFallback(pack(), [
    probe("https://primary.example/report", { contentHash: PRIMARY_HASH }),
  ]);
  assert.equal(clean.degraded, false);
  for (const probes of [
    [
      probe("https://primary.example/report", { contentHash: OTHER_HASH }),
      probe("https://mirror.example/report", { contentHash: CORROB_HASH }),
    ],
    [
      probe("https://primary.example/report", { available: false }),
      probe("https://mirror.example/report", { contentHash: CORROB_HASH }),
    ],
    [probe("https://primary.example/report", { available: false })],
  ]) {
    assert.equal(decideSourceFallback(pack(), probes).degraded, true);
  }
});

test("a market with no corroborating sources at all is handled", () => {
  const outcome = decideSourceFallback(pack({ corroboratingSources: [] }), [
    probe("https://primary.example/report", { available: false }),
  ]);
  assert.equal(outcome.decision, "unresolvable");
  assert.equal(outcome.probed.length, 1);
});
