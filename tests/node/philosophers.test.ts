import assert from "node:assert/strict";
import test from "node:test";

import {
  PHILOSOPHER_PERSONAS,
  PHILOSOPHER_PROMPT_VERSION,
  activePhilosophers,
  isPhilosopher,
  philosopherAddressEnv,
  philosopherPrivateKeyEnv,
} from "../../agents/council/philosophers";
import {
  COUNCIL_PERSONAS,
  configureCouncilPersonaRegistry,
  listCouncilPersonas,
  personaPrivateKeyEnv,
  resetCouncilPersonaRegistry,
} from "../../agents/council/personas";
import {
  PHILOSOPHER_CALIBRATION_SET,
  evaluateCalibrationResponse,
} from "../../agents/council/philosopher-calibration";

test("the philosopher jury is non-empty and every member is tagged", () => {
  assert.ok(PHILOSOPHER_PERSONAS.length >= 6);
  for (const p of PHILOSOPHER_PERSONAS) {
    assert.equal(p.track, "philosopher");
    assert.equal(isPhilosopher(p), true);
  }
});

test("no philosopher slug collides with the classic council", () => {
  // Wallet env vars are COUNCIL_<SLUG>_PRIVATE_KEY across BOTH tracks, so a
  // duplicate slug would silently make two jurors share one wallet and one vote.
  const classic = new Set(COUNCIL_PERSONAS.map((p) => p.slug));
  for (const p of PHILOSOPHER_PERSONAS) {
    assert.equal(classic.has(p.slug), false, `slug '${p.slug}' exists in both tracks`);
  }
});

test("philosopher slugs are unique and env-var safe", () => {
  const seen = new Set<string>();
  for (const p of PHILOSOPHER_PERSONAS) {
    assert.equal(seen.has(p.slug), false, `duplicate slug '${p.slug}'`);
    seen.add(p.slug);
    assert.match(p.slug, /^[a-z][a-z0-9-]*$/, `slug '${p.slug}' is not kebab-case`);
  }
});

test("wallet env names are derived deterministically from the slug", () => {
  assert.equal(philosopherPrivateKeyEnv("lao-tzu"), "COUNCIL_LAO_TZU_PRIVATE_KEY");
  assert.equal(philosopherAddressEnv("lao-tzu"), "COUNCIL_LAO_TZU_ADDRESS");
  assert.equal(philosopherPrivateKeyEnv("socrates"), "COUNCIL_SOCRATES_PRIVATE_KEY");
});

test("classic council members are not mistaken for philosophers", () => {
  for (const p of COUNCIL_PERSONAS) {
    assert.equal(isPhilosopher(p), false);
  }
});

// ── Rubrics must be real, distinct methods — not decoration ───────────────────

test("every philosopher carries a multi-step rubric", () => {
  for (const p of PHILOSOPHER_PERSONAS) {
    assert.ok(p.rubric.length >= 4, `${p.slug} has only ${p.rubric.length} rubric steps`);
    for (const step of p.rubric) {
      assert.ok(step.trim().length > 12, `${p.slug} has a stub rubric step`);
    }
  }
});

test("no two philosophers share a rubric or a reasoning method", () => {
  // Identical methods would mean the spread of votes is stylistic, not
  // epistemic — exactly what the roadmap says not to build.
  const rubrics = new Set<string>();
  const methods = new Set<string>();
  for (const p of PHILOSOPHER_PERSONAS) {
    const rubric = p.rubric.join("|");
    assert.equal(rubrics.has(rubric), false, `${p.slug} duplicates another rubric`);
    rubrics.add(rubric);
    assert.equal(methods.has(p.reasoningMethod), false, `${p.slug} duplicates a reasoning method`);
    methods.add(p.reasoningMethod);
  }
});

test("every rubric ends with an explicit route to a verdict or abstention", () => {
  for (const p of PHILOSOPHER_PERSONAS) {
    const last = p.rubric[p.rubric.length - 1];
    assert.match(
      last,
      /UNRESOLVABLE|verdict|confidence/i,
      `${p.slug}'s rubric does not end by producing a verdict`,
    );
  }
});

test("at least one juror can reach UNRESOLVABLE, and lao-tzu defaults to it", () => {
  // Without a principled abstainer a jury manufactures confidence on
  // genuinely undecidable claims.
  const abstainers = PHILOSOPHER_PERSONAS.filter((p) =>
    p.rubric.some((step) => /UNRESOLVABLE/.test(step)),
  );
  assert.ok(abstainers.length >= 3);

  const laoTzu = PHILOSOPHER_PERSONAS.find((p) => p.slug === "lao-tzu");
  assert.ok(laoTzu);
  assert.match(laoTzu!.promptBias ?? "", /abstention is your default/i);
  // Strictest confidence bar in the jury.
  const bars = PHILOSOPHER_PERSONAS.map((p) => p.minConfidence ?? 0);
  assert.equal(laoTzu!.minConfidence, Math.max(...bars));
});

test("the shared adjudication contract is in every prompt", () => {
  for (const p of PHILOSOPHER_PERSONAS) {
    const prompt = p.promptBias ?? "";
    assert.match(prompt, /adjudicating a settled prediction market/i, `${p.slug} lost the contract`);
    assert.match(prompt, /[Nn]ever invent evidence/, `${p.slug} may invent evidence`);
    assert.match(prompt, /UNRESOLVABLE/, `${p.slug} has no abstention route`);
    // The rubric must be visible in the prompt so published reasoning can be
    // checked against the method the persona claims to follow.
    for (const step of p.rubric) {
      assert.ok(prompt.includes(step), `${p.slug}'s prompt omits a rubric step`);
    }
  }
});

test("polarity pairs reference philosophers that actually exist", () => {
  const slugs = new Set(PHILOSOPHER_PERSONAS.map((p) => p.slug));
  for (const p of PHILOSOPHER_PERSONAS) {
    assert.ok(p.polarityPairs.length > 0, `${p.slug} has no opposing frame`);
    for (const pair of p.polarityPairs) {
      assert.equal(slugs.has(pair), true, `${p.slug} pairs with unknown '${pair}'`);
      assert.notEqual(pair, p.slug, `${p.slug} is paired with itself`);
    }
  }
});

// ── Risk limits are data, not prompt text ─────────────────────────────────────

test("every philosopher has bounded, non-zero risk limits", () => {
  for (const p of PHILOSOPHER_PERSONAS) {
    assert.ok(p.limits.maxStakeUsdc > 0, `${p.slug} has no stake limit`);
    assert.ok(p.limits.maxStakeUsdc <= 5, `${p.slug} stake limit ${p.limits.maxStakeUsdc} is too high`);
    assert.ok(p.limits.maxX402BudgetUsdc > 0, `${p.slug} has no x402 budget`);
    assert.ok(
      p.limits.maxX402BudgetUsdc <= 0.05,
      `${p.slug} x402 budget ${p.limits.maxX402BudgetUsdc} is too high`,
    );
    assert.ok(p.limits.maxClaimsPerCycle >= 1);
  }
});

test("the declared stake never exceeds the persona's own limit", () => {
  for (const p of PHILOSOPHER_PERSONAS) {
    assert.ok(
      (p.stakeUsdc ?? 0) <= p.limits.maxStakeUsdc,
      `${p.slug} stakes ${p.stakeUsdc} against a ${p.limits.maxStakeUsdc} limit`,
    );
  }
});

test("prompt versions are stamped so votes stay comparable across changes", () => {
  for (const p of PHILOSOPHER_PERSONAS) {
    assert.equal(p.promptVersion, PHILOSOPHER_PROMPT_VERSION);
  }
});

// ── Registry seam ─────────────────────────────────────────────────────────────

test("activePhilosophers returns everyone when unset", () => {
  assert.equal(activePhilosophers("").length, PHILOSOPHER_PERSONAS.length);
  assert.equal(activePhilosophers(undefined).length, PHILOSOPHER_PERSONAS.length);
});

test("activePhilosophers narrows to a csv subset and ignores unknown slugs", () => {
  const subset = activePhilosophers("socrates, lao-tzu ,nobody");
  assert.deepEqual(
    subset.map((p) => p.slug),
    ["socrates", "lao-tzu"],
  );
});

// ── Wallet env namespacing ────────────────────────────────────────────────────

test("no philosopher shares a slug with a classic persona", () => {
  // Both tracks derive COUNCIL_<SLUG>_PRIVATE_KEY from the slug, so a collision
  // would silently hand two personas the same wallet — and the same money.
  const classic = new Set(COUNCIL_PERSONAS.map((p) => p.slug));
  for (const philosopher of PHILOSOPHER_PERSONAS) {
    assert.equal(
      classic.has(philosopher.slug),
      false,
      `${philosopher.slug} collides with a classic persona`,
    );
  }
});

test("every persona across both tracks maps to a distinct key env", () => {
  const envs = [
    ...COUNCIL_PERSONAS.map((p) => personaPrivateKeyEnv(p)),
    ...PHILOSOPHER_PERSONAS.map((p) => philosopherPrivateKeyEnv(p.slug)),
  ];
  assert.equal(new Set(envs).size, envs.length);
});

test("a hyphenated slug becomes a valid env name", () => {
  // lao-tzu must not produce COUNCIL_LAO-TZU_PRIVATE_KEY, which no shell exports.
  assert.equal(philosopherPrivateKeyEnv("lao-tzu"), "COUNCIL_LAO_TZU_PRIVATE_KEY");
  for (const persona of PHILOSOPHER_PERSONAS) {
    assert.match(philosopherPrivateKeyEnv(persona.slug), /^COUNCIL_[A-Z0-9_]+_PRIVATE_KEY$/);
  }
});

test("every philosopher has a minimum calibration, bias and consistency set", () => {
  for (const persona of PHILOSOPHER_PERSONAS) {
    const fixtures = PHILOSOPHER_CALIBRATION_SET.filter((row) => row.personaSlug === persona.slug);
    assert.ok(fixtures.length >= 5, `${persona.slug} has too few fixtures`);
    assert.ok(fixtures.some((row) => row.expectedVerdict === "CREATOR_WINS"));
    assert.ok(fixtures.some((row) => row.expectedVerdict === "CHALLENGERS_WIN"));
    assert.ok(fixtures.some((row) => row.kind === "bias" && row.expectedVerdict === "UNRESOLVABLE"));

    const consistency = fixtures.filter((row) => row.kind === "consistency");
    assert.equal(new Set(consistency.map((row) => row.consistencyKey)).size, 1);
    assert.equal(new Set(consistency.map((row) => row.expectedVerdict)).size, 1);
  }
});

test("calibration responses enforce verdict, bounds and reasoning method", () => {
  const fixture = PHILOSOPHER_CALIBRATION_SET[0]!;
  assert.deepEqual(
    evaluateCalibrationResponse(fixture, {
      verdict: fixture.expectedVerdict,
      confidenceBps: 8_000,
      reasoningMethod: fixture.reasoningMethod,
    }),
    [],
  );
  assert.equal(
    evaluateCalibrationResponse(fixture, {
      verdict: "UNRESOLVABLE",
      confidenceBps: 10_001,
      reasoningMethod: "style-only",
    }).length,
    3,
  );
});

test("the classic roster is replaceable through a validated registry adapter", () => {
  const first = COUNCIL_PERSONAS[0]!;
  configureCouncilPersonaRegistry({ listClassicPersonas: () => [first] });
  assert.deepEqual(listCouncilPersonas().map((persona) => persona.slug), [first.slug]);
  assert.throws(
    () => configureCouncilPersonaRegistry({ listClassicPersonas: () => [first, first] }),
    /invalid council persona registry slug/,
  );
  resetCouncilPersonaRegistry();
  assert.equal(listCouncilPersonas().length, COUNCIL_PERSONAS.length);
});
