import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_METADATA_VERSION,
  MAX_DESCRIPTION_CHARS,
  MAX_NAME_CHARS,
  canonicalMetadataJson,
  disclosureSummary,
  validateAgentMetadata,
  type AgentMetadata,
} from "../../lib/agents/metadata";

function metadata(overrides: Partial<AgentMetadata> = {}): AgentMetadata {
  return {
    version: AGENT_METADATA_VERSION,
    name: "Sceptic",
    description: "Reads the primary source and refuses to guess.",
    reasoningPolicy: "summary_public_detail_paid",
    sourcePolicy: "declared_plus_corroborating",
    modelDisclosure: "claude-sonnet-5",
    humanOversight: "reviewed_after_action",
    contact: "ops@example.org",
    termsUrl: "https://example.org/terms",
    ...overrides,
  };
}

test("a complete document validates", () => {
  const result = validateAgentMetadata(metadata());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

// ── Required disclosures ──────────────────────────────────────────────────────

test("the model disclosure is required, because its absence is the signal", () => {
  // An optional field would make "will not say" look identical to "not finished".
  assert.deepEqual(validateAgentMetadata(metadata({ modelDisclosure: "" })).errors, [
    "modelDisclosure is required",
  ]);
  assert.deepEqual(validateAgentMetadata(metadata({ modelDisclosure: "   " })).errors, [
    "modelDisclosure is required",
  ]);
});

test("every policy field is required", () => {
  for (const field of ["reasoningPolicy", "sourcePolicy", "humanOversight"] as const) {
    const result = validateAgentMetadata(metadata({ [field]: undefined } as never));
    assert.equal(result.ok, false, field);
    assert.ok(result.errors.some((e) => e.startsWith(field)), field);
  }
});

test("an invented policy value is refused", () => {
  const result = validateAgentMetadata(metadata({ reasoningPolicy: "trust_me" as never }));
  assert.equal(result.ok, false);
});

test("name and description are required and bounded", () => {
  assert.ok(validateAgentMetadata(metadata({ name: "" })).errors.includes("name is required"));
  assert.ok(
    validateAgentMetadata(metadata({ name: "x".repeat(MAX_NAME_CHARS + 1) })).errors.some((e) =>
      e.includes("at most"),
    ),
  );
  assert.ok(
    validateAgentMetadata(metadata({ description: "y".repeat(MAX_DESCRIPTION_CHARS + 1) })).errors
      .length > 0,
  );
});

test("a name of only punctuation or invisible characters is refused", () => {
  // It renders as blank, or as another agent's name, in a list.
  for (const name of ["...", "   ", "​​", "---"]) {
    assert.equal(validateAgentMetadata(metadata({ name })).ok, false, JSON.stringify(name));
  }
  // A non-Latin name is perfectly valid.
  assert.equal(validateAgentMetadata(metadata({ name: "懐疑論者" })).ok, true);
});

test("contact is required", () => {
  assert.ok(validateAgentMetadata(metadata({ contact: " " })).errors.includes("contact is required"));
});

test("a version mismatch is refused", () => {
  assert.equal(validateAgentMetadata(metadata({ version: 99 })).ok, false);
});

// ── URLs ──────────────────────────────────────────────────────────────────────

test("profile URLs must be https", () => {
  assert.ok(
    validateAgentMetadata(metadata({ avatarUrl: "http://example.org/a.png" })).errors.some((e) =>
      e.includes("https"),
    ),
  );
});

test("a URL carrying credentials is refused", () => {
  // A profile URL is shown to strangers.
  const result = validateAgentMetadata(metadata({ termsUrl: "https://u:p@example.org/t" }));
  assert.ok(result.errors.some((e) => e.includes("credentials")));
});

test("a relative URL is refused", () => {
  assert.equal(validateAgentMetadata(metadata({ avatarUrl: "/avatar.png" })).ok, false);
});

test("an absent avatar is fine", () => {
  // An agent with no picture is still an agent.
  assert.equal(validateAgentMetadata(metadata({ avatarUrl: undefined })).ok, true);
});

// ── Warnings ──────────────────────────────────────────────────────────────────

test("publishing no reasoning warns but does not block", () => {
  // A legitimate choice a reader should see, not a reason to hide the profile.
  const result = validateAgentMetadata(metadata({ reasoningPolicy: "none" }));
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.includes("publishes no reasoning")));
});

test("acting without human review warns", () => {
  const result = validateAgentMetadata(metadata({ humanOversight: "none" }));
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.includes("without human review")));
});

test("missing terms warns, since somebody may copy this agent", () => {
  const result = validateAgentMetadata(metadata({ termsUrl: undefined }));
  assert.ok(result.warnings.some((w) => w.includes("no terms published")));
});

test("a basename always carries the not-verified warning", () => {
  // A name that looks official is exactly what a reader over-trusts.
  const result = validateAgentMetadata(metadata({ basename: "sceptic.base.eth" }));
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.includes("not a verified identity")));
});

test("no basename means no basename warning", () => {
  const result = validateAgentMetadata(metadata());
  assert.equal(result.warnings.some((w) => w.includes("verified identity")), false);
});

// ── Canonical hashing input ───────────────────────────────────────────────────

test("key order does not change the canonical form", () => {
  // A hash that depended on insertion order would flag an edit that never happened.
  const a = canonicalMetadataJson(metadata());
  const reordered: AgentMetadata = {
    contact: "ops@example.org",
    description: "Reads the primary source and refuses to guess.",
    humanOversight: "reviewed_after_action",
    modelDisclosure: "claude-sonnet-5",
    name: "Sceptic",
    reasoningPolicy: "summary_public_detail_paid",
    sourcePolicy: "declared_plus_corroborating",
    termsUrl: "https://example.org/terms",
    version: AGENT_METADATA_VERSION,
  };
  assert.equal(canonicalMetadataJson(reordered), a);
});

test("whitespace around a value does not change the canonical form", () => {
  assert.equal(
    canonicalMetadataJson(metadata({ name: "  Sceptic  " })),
    canonicalMetadataJson(metadata()),
  );
});

test("a real edit does change the canonical form", () => {
  assert.notEqual(
    canonicalMetadataJson(metadata({ modelDisclosure: "something-else" })),
    canonicalMetadataJson(metadata()),
  );
});

test("an absent optional field is not confusable with an empty one", () => {
  // Both canonicalise to "", which is intended — an empty avatar and no avatar are
  // the same fact — but a DIFFERENT field's value must not shift into its slot.
  const absent = canonicalMetadataJson(metadata({ avatarUrl: undefined, termsUrl: undefined }));
  const shifted = canonicalMetadataJson(
    metadata({ avatarUrl: "https://example.org/terms", termsUrl: undefined }),
  );
  assert.notEqual(absent, shifted);
});

test("a basename differing only in case canonicalises the same", () => {
  assert.equal(
    canonicalMetadataJson(metadata({ basename: "Sceptic.Base.ETH" })),
    canonicalMetadataJson(metadata({ basename: "sceptic.base.eth" })),
  );
});

// ── Disclosure summary ────────────────────────────────────────────────────────

test("the disclosure summary lists all four disclosures", () => {
  // A list rather than a paragraph, so a UI cannot render only the flattering half.
  const lines = disclosureSummary(metadata());
  assert.equal(lines.length, 4);
  assert.ok(lines[0].includes("claude-sonnet-5"));
});

test("an undisclosed model says so explicitly", () => {
  const lines = disclosureSummary(metadata({ modelDisclosure: "" }));
  assert.ok(lines[0].includes("not disclosed"));
});
