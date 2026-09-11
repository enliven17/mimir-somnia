/**
 * The whole council in one place: the classic frames plus the philosophers.
 *
 * They live in two modules because they are written differently — one set
 * decides by rule, the other through an LLM with a persona bias — and
 * `listCouncilPersonas()` returns only the first set. Anything that resolves a
 * seat from outside the worker wants both, and when it forgets, the failure is
 * silent: the fifteen philosophers staked their own money on chain while every
 * paid endpoint answered "unknown persona" to reads someone tried to buy from
 * them.
 *
 * Deliberately free of `server-only` and of any chain or database import, so a
 * plain node test can assert the roster is whole.
 */

import { listCouncilPersonas, type PersonaSpec } from "./personas";
import { PHILOSOPHER_PERSONAS } from "./philosophers";

/** Every seat, classic frames first. */
export function allCouncilPersonas(): PersonaSpec[] {
  return [...listCouncilPersonas(), ...PHILOSOPHER_PERSONAS];
}

/**
 * Resolve a seat by slug. Slugs arrive from URL query strings, so the match
 * tolerates case and surrounding whitespace and nothing else.
 */
export function getCouncilPersonaBySlug(slug: string): PersonaSpec | null {
  const wanted = slug.trim().toLowerCase();
  if (!wanted) return null;
  return allCouncilPersonas().find((persona) => persona.slug === wanted) ?? null;
}
