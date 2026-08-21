import assert from "node:assert/strict";
import test from "node:test";

import {
  CATEGORY_POLICIES,
  allowedCategories,
  blockedCategories,
  categoryPolicy,
  checkCategory,
  isRestrictedCategoryEnabled,
  restrictedCategories,
  templatePlaceholders,
  type CategoryCandidate,
} from "../../lib/research/categories";

const HOUR = 3_600;
const DAY = 86_400;

function candidate(overrides: Partial<CategoryCandidate> = {}): CategoryCandidate {
  return {
    category: "crypto",
    primarySourceDomain: "coingecko.com",
    corroboratingDomains: ["kraken.com"],
    sourceAgeSeconds: 60,
    secondsUntilDeadline: 2 * DAY,
    settlementRule:
      "Settle on CoinGecko's reported daily close for BTC at 00:00, in UTC, rounded 2dp. Exact equality with 100000 resolves draw. Void if CoinGecko publishes no value.",
    ...overrides,
  };
}

// ── Blocked topics have no override path ──────────────────────────────────────

test("blocked categories are refused even with every flag set", () => {
  // These are out of scope because they are wrong to run, not because the
  // plumbing is unfinished — so no env var may enable them.
  const everyFlag: Record<string, string> = {};
  for (const policy of CATEGORY_POLICIES) {
    everyFlag[`MIMIR_COMPLIANCE_ALLOW_${policy.id.toUpperCase()}`] = "1";
  }
  for (const policy of blockedCategories()) {
    const result = checkCategory(candidate({ category: policy.id }), everyFlag);
    assert.equal(result.ok, false, `${policy.id} must stay blocked`);
    assert.equal(result.reason, "blocked_category");
  }
});

test("the blocked list covers the topics the roadmap names", () => {
  const ids = blockedCategories().map((policy) => policy.id);
  for (const required of [
    "health_outcomes",
    "death_violence",
    "private_individuals",
    "illegal_activity",
  ]) {
    assert.ok(ids.includes(required), `missing blocked category '${required}'`);
  }
});

test("every blocked category explains why", () => {
  for (const policy of blockedCategories()) {
    assert.ok((policy.note ?? "").length > 20, `${policy.id} has no stated reason`);
  }
});

// ── Restricted topics need an explicit compliance decision ────────────────────

test("elections and policy are restricted, not allowed by default", () => {
  const ids = restrictedCategories().map((policy) => policy.id);
  assert.ok(ids.includes("elections"));
  assert.ok(ids.includes("policy"));

  const result = checkCategory(
    candidate({
      category: "elections",
      primarySourceDomain: "authority.gov",
      corroboratingDomains: ["a.com", "b.com"],
      settlementRule: "Settle on the certified result published by the authority, in UTC.",
    }),
    {},
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "compliance_gate");
});

test("a restricted category opens only with its own flag", () => {
  const base = candidate({
    category: "elections",
    primarySourceDomain: "authority.gov",
    corroboratingDomains: ["a.com", "b.com"],
    settlementRule: "Settle on the certified result published by the authority, in UTC.",
  });
  assert.equal(isRestrictedCategoryEnabled("elections", { MIMIR_COMPLIANCE_ALLOW_ELECTIONS: "1" }), true);
  assert.equal(checkCategory(base, { MIMIR_COMPLIANCE_ALLOW_ELECTIONS: "1" }).ok, true);
  // A flag for a different topic does not unlock it.
  assert.equal(checkCategory(base, { MIMIR_COMPLIANCE_ALLOW_POLICY: "1" }).ok, false);
});

// ── Source counting ───────────────────────────────────────────────────────────

test("the primary source's own domain never counts as corroboration", () => {
  // Two pages on one site are one source wearing two hats.
  const result = checkCategory(
    candidate({ primarySourceDomain: "coingecko.com", corroboratingDomains: ["coingecko.com"] }),
    {},
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "too_few_sources");
  assert.match(result.detail ?? "", /1 of 2/);
});

test("duplicate corroborating domains are counted once", () => {
  const result = checkCategory(
    candidate({
      category: "culture",
      primarySourceDomain: "a.com",
      corroboratingDomains: ["b.com", "b.com", "b.com"],
      settlementRule: "Settle on the published figure for the subject covering the period, in UTC.",
    }),
    {},
  );
  assert.equal(result.ok, false);
  // culture needs three independent domains; a.com + b.com is two.
  assert.match(result.detail ?? "", /2 of 3/);
});

test("culture demands more corroboration than crypto", () => {
  // The weakest sourcing of the wave gets the strictest requirement.
  assert.ok(
    categoryPolicy("culture")!.minIndependentSources >
      categoryPolicy("crypto")!.minIndependentSources,
  );
});

test("a single official agency is enough for macro", () => {
  const policy = categoryPolicy("macro")!;
  assert.equal(policy.minIndependentSources, 1);
  assert.equal(
    checkCategory(
      candidate({
        category: "macro",
        primarySourceDomain: "bls.gov",
        corroboratingDomains: [],
        sourceAgeSeconds: HOUR,
        settlementRule:
          "Settle on the FIRST published print of CPI for May by BLS, in percent rounded 1dp. Later revisions do not change the outcome.",
      }),
      {},
    ).ok,
    true,
  );
});

// ── Primary source allowlists ─────────────────────────────────────────────────

test("a crypto market cannot be settled by an unrecognised site", () => {
  const result = checkCategory(
    candidate({ primarySourceDomain: "some-blog.example", corroboratingDomains: ["kraken.com"] }),
    {},
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "primary_source_not_allowed");
});

test("a subdomain of an allowlisted authority is accepted", () => {
  assert.equal(
    checkCategory(candidate({ primarySourceDomain: "api.coingecko.com" }), {}).ok,
    true,
  );
});

test("a lookalike domain does not satisfy the allowlist", () => {
  assert.equal(
    checkCategory(candidate({ primarySourceDomain: "notcoingecko.com" }), {}).reason,
    "primary_source_not_allowed",
  );
});

test("categories with no canonical authority accept any gateway-passed source", () => {
  // Sports has no single global authority; the competition's own result is primary.
  const policy = categoryPolicy("sports")!;
  assert.deepEqual(policy.primarySourceAllowlist, []);
  assert.ok((policy.note ?? "").length > 0, "an empty allowlist must be explained");
  assert.equal(
    checkCategory(
      candidate({
        category: "sports",
        primarySourceDomain: "premierleague.com",
        corroboratingDomains: ["bbc.co.uk"],
        sourceAgeSeconds: HOUR,
        settlementRule:
          "Settle on the official result published by the Premier League for the fixture on 2026-05-25, in UTC. Void if postponed. Overtime counts.",
      }),
      {},
    ).ok,
    true,
  );
});

// ── Freshness and deadlines ───────────────────────────────────────────────────

test("a stale primary source is refused", () => {
  const result = checkCategory(candidate({ sourceAgeSeconds: 24 * HOUR }), {});
  assert.equal(result.ok, false);
  assert.equal(result.reason, "source_too_stale");
});

test("a stocks market cannot have an intraday deadline", () => {
  // An intraday claim cannot be settled on a published session close.
  const result = checkCategory(
    candidate({
      category: "stocks",
      primarySourceDomain: "nasdaq.com",
      corroboratingDomains: ["sec.gov"],
      sourceAgeSeconds: 60,
      secondsUntilDeadline: 2 * HOUR,
      settlementRule:
        "Settle on the official closing price for AAPL on Nasdaq for the session ending 2026-05-25, in UTC, in USD rounded 2dp.",
    }),
    {},
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "deadline_too_soon");
  assert.ok(categoryPolicy("stocks")!.minDeadlineSeconds >= DAY);
});

test("an absurdly distant deadline is refused", () => {
  const result = checkCategory(candidate({ secondsUntilDeadline: 5_000 * DAY }), {});
  assert.equal(result.ok, false);
  assert.equal(result.reason, "deadline_too_far");
});

test("weather waits for a revised observation before settling", () => {
  // Official observations get revised; settling on the first reading is a bug.
  assert.ok(categoryPolicy("weather")!.resolutionWindowSeconds >= 6 * HOUR);
});

// ── Settlement templates ──────────────────────────────────────────────────────

test("an unfilled template placeholder is refused", () => {
  // A copied template is not a completed rule.
  const result = checkCategory(
    candidate({ settlementRule: "Settle on {source}'s close for {asset} in {timezone}." }),
    {},
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unfilled_template");
  assert.match(result.detail ?? "", /\{source\}/);
});

test("every non-blocked category ships a template with placeholders", () => {
  for (const policy of [...allowedCategories(), ...restrictedCategories()]) {
    assert.ok(policy.settlementTemplate.length > 40, `${policy.id} has no template`);
    assert.ok(
      templatePlaceholders(policy.id).length >= 2,
      `${policy.id}'s template has nothing to fill in`,
    );
  }
});

test("every non-blocked template pins down a timezone", () => {
  // A dated claim without a timezone is undecidable.
  for (const policy of [...allowedCategories(), ...restrictedCategories()]) {
    assert.match(
      policy.settlementTemplate,
      /timezone|in \{timezone\}/i,
      `${policy.id}'s template does not fix a timezone`,
    );
  }
});

test("every non-blocked template states a void condition", () => {
  // Without one, a source that never publishes leaves the market unsettleable.
  for (const policy of [...allowedCategories(), ...restrictedCategories()]) {
    assert.match(
      policy.settlementTemplate,
      /void/i,
      `${policy.id}'s template has no void rule`,
    );
  }
});

test("blocked categories carry no template to accidentally use", () => {
  for (const policy of blockedCategories()) {
    assert.equal(policy.settlementTemplate, "");
  }
});

// ── Registry hygiene ──────────────────────────────────────────────────────────

test("category ids are unique and lookup is case-insensitive", () => {
  const ids = CATEGORY_POLICIES.map((policy) => policy.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(categoryPolicy("CRYPTO")?.id, "crypto");
  assert.equal(categoryPolicy(" crypto ")?.id, "crypto");
  assert.equal(categoryPolicy("nonexistent"), null);
});

test("an unknown category is refused rather than defaulted", () => {
  const result = checkCategory(candidate({ category: "vibes" }), {});
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unknown_category");
});

test("the first adapter wave covers the roadmap's list", () => {
  const ids = allowedCategories().map((policy) => policy.id);
  for (const required of [
    "crypto",
    "sports",
    "weather",
    "stocks",
    "macro",
    "technology",
    "opensource",
    "gaming",
    "entertainment",
    "awards",
    "science",
    "culture",
  ]) {
    assert.ok(ids.includes(required), `missing adapter for '${required}'`);
  }
});

test("a fully valid crypto candidate passes", () => {
  assert.deepEqual(checkCategory(candidate(), {}), { ok: true });
});
