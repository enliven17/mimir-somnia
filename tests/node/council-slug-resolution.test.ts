/**
 * Every seat on the council must be reachable by slug from outside the worker.
 *
 * The paid endpoints resolve a persona from a query string before they charge or
 * answer. They used to resolve through the personas module's own list, which
 * holds the classic frames only — so the fifteen philosophers staked their own
 * money on chain all day and answered "unknown persona" to every read someone
 * tried to buy from them, including peer reads from other personas. A compile
 * catches none of that: the lookup is well-typed and simply returns null.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { getCouncilPersonaBySlug } from "../../agents/council/roster";
import { listCouncilPersonas } from "../../agents/council/personas";
import { PHILOSOPHER_PERSONAS } from "../../agents/council/philosophers";

test("every classic frame resolves by its own slug", () => {
  for (const persona of listCouncilPersonas()) {
    assert.equal(getCouncilPersonaBySlug(persona.slug)?.slug, persona.slug);
  }
});

test("every philosopher resolves too — this is the seat that used to 400", () => {
  assert.ok(PHILOSOPHER_PERSONAS.length > 0, "no philosophers to check");
  for (const persona of PHILOSOPHER_PERSONAS) {
    assert.equal(
      getCouncilPersonaBySlug(persona.slug)?.slug,
      persona.slug,
      `philosopher '${persona.slug}' is unreachable by slug`,
    );
  }
});

test("lookup is case- and whitespace-insensitive, and rejects a stranger", () => {
  // Slugs arrive from a URL query string, where a trailing space survives.
  const first = listCouncilPersonas()[0];
  assert.ok(first);
  assert.equal(getCouncilPersonaBySlug(` ${first.slug.toUpperCase()} `)?.slug, first.slug);
  assert.equal(getCouncilPersonaBySlug("not-a-persona"), null);
  assert.equal(getCouncilPersonaBySlug(""), null);
});
