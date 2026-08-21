/**
 * Per-category source policy for automatically created markets.
 *
 * A market is only as settleable as its source. "Will X happen?" with a blog post
 * as the resolution source is not a market, it is an argument waiting to happen —
 * so each topic declares, as data, what counts as a primary source, how many
 * independent sources it needs, how fresh they must be, and how long after the
 * deadline the answer should be available.
 *
 * Three tiers, and the distinction matters:
 *
 *   allowed     the agent may create autonomously
 *   restricted  needs an explicit compliance flag (elections, public policy)
 *   blocked     never created, at any flag level
 *
 * Blocked is not "off by default". Health outcomes, death and violence, personal
 * harm, illegal activity and unverifiable claims about private individuals stay
 * out because they are wrong to run as prediction markets, not because the
 * plumbing is unfinished — so there is deliberately no env var that enables them.
 */

import { recordCategoryCoverage, recordCategoryReject } from "./telemetry";

export type CategoryTier = "allowed" | "restricted" | "blocked";

export interface CategoryPolicy {
  id: string;
  tier: CategoryTier;
  /** Independent domains required before an autonomous market may open. */
  minIndependentSources: number;
  /**
   * Domains trusted to be the PRIMARY (deciding) source. Empty on an allowed
   * category means any source that passes the gateway may decide — used only
   * where no canonical authority exists.
   */
  primarySourceAllowlist: string[];
  /** How old the primary source's content may be at capture, seconds. */
  maxSourceAgeSeconds: number;
  /**
   * How long after the deadline the source is expected to publish. Markets are
   * not settleable before this elapses.
   */
  resolutionWindowSeconds: number;
  /** Shortest deadline worth creating, seconds from now. */
  minDeadlineSeconds: number;
  maxDeadlineSeconds: number;
  /**
   * Template the settlement rule must fill. Kept per category because the
   * ambiguities differ: crypto needs a venue and a timezone, sports needs the
   * competition and what happens if the fixture is postponed.
   */
  settlementTemplate: string;
  /** Why this topic is restricted or blocked. Shown in review tooling. */
  note?: string;
}

const HOUR = 3_600;
const DAY = 86_400;

/**
 * The first adapter wave. Ordered by how reliably a machine can settle them —
 * crypto and weather have canonical numeric sources; culture does not, which is
 * why it demands more corroboration and a longer window.
 */
export const CATEGORY_POLICIES: CategoryPolicy[] = [
  {
    id: "crypto",
    tier: "allowed",
    minIndependentSources: 2,
    primarySourceAllowlist: ["coingecko.com", "coinmarketcap.com", "kraken.com", "coinbase.com"],
    maxSourceAgeSeconds: 15 * 60,
    resolutionWindowSeconds: HOUR,
    minDeadlineSeconds: HOUR,
    maxDeadlineSeconds: 180 * DAY,
    settlementTemplate:
      "Settle on {source}'s reported {metric} for {asset} at {instant}, in {timezone}, rounded {rounding}. Exact equality with {threshold} resolves {tieBreak}. Void if {source} publishes no value for that instant.",
  },
  {
    id: "weather",
    tier: "allowed",
    minIndependentSources: 2,
    primarySourceAllowlist: ["weather.gov", "api.weather.gov", "metoffice.gov.uk", "dwd.de", "mgm.gov.tr"],
    maxSourceAgeSeconds: HOUR,
    // Official observations are revised; do not settle on the first reading.
    resolutionWindowSeconds: 6 * HOUR,
    minDeadlineSeconds: 6 * HOUR,
    maxDeadlineSeconds: 30 * DAY,
    settlementTemplate:
      "Settle on {source}'s official observation for {station} covering {period}, in {timezone}, in {units} rounded {rounding}. Use the first revised value published after the period closes. Void if no observation is published.",
  },
  {
    id: "sports",
    tier: "allowed",
    minIndependentSources: 2,
    primarySourceAllowlist: [],
    maxSourceAgeSeconds: 2 * HOUR,
    resolutionWindowSeconds: 3 * HOUR,
    minDeadlineSeconds: HOUR,
    maxDeadlineSeconds: 365 * DAY,
    settlementTemplate:
      "Settle on the official result published by {competition} for {fixture} on {date}, in {timezone}. Void if the fixture is postponed, abandoned or rescheduled beyond {deadline}. Overtime and penalties {countRule}.",
    note: "No single global authority; the competition's own result is primary.",
  },
  {
    id: "stocks",
    tier: "allowed",
    minIndependentSources: 2,
    primarySourceAllowlist: ["nasdaq.com", "nyse.com", "sec.gov", "borsaistanbul.com"],
    maxSourceAgeSeconds: HOUR,
    resolutionWindowSeconds: 2 * HOUR,
    // Nothing shorter than a session: an intraday claim cannot be settled on a
    // published close.
    minDeadlineSeconds: DAY,
    maxDeadlineSeconds: 365 * DAY,
    settlementTemplate:
      "Settle on the official closing price for {ticker} on {exchange} for the session ending {date}, in {timezone}, in {units} rounded {rounding}. Void if the session does not occur or trading is halted for the day.",
  },
  {
    id: "macro",
    tier: "allowed",
    minIndependentSources: 1,
    primarySourceAllowlist: ["bls.gov", "bea.gov", "federalreserve.gov", "ecb.europa.eu", "eurostat.ec.europa.eu", "tuik.gov.tr"],
    maxSourceAgeSeconds: 24 * HOUR,
    // Statistical releases are revised; the FIRST print is what settles.
    resolutionWindowSeconds: 24 * HOUR,
    minDeadlineSeconds: DAY,
    maxDeadlineSeconds: 365 * DAY,
    settlementTemplate:
      "Settle on the FIRST published print of {series} for {period} by {agency}, released at {releaseTime} in {timezone}, in {units} rounded {rounding}. Later revisions do not change the outcome. Void if the release is cancelled or delayed beyond {deadline}.",
    note: "One official agency is authoritative, so a single source is enough.",
  },
  {
    id: "technology",
    tier: "allowed",
    minIndependentSources: 2,
    primarySourceAllowlist: [],
    maxSourceAgeSeconds: 12 * HOUR,
    resolutionWindowSeconds: 12 * HOUR,
    minDeadlineSeconds: DAY,
    maxDeadlineSeconds: 365 * DAY,
    settlementTemplate:
      "Settle on {vendor}'s own public announcement of {event} on {source}, timestamped before {deadline} in {timezone}. A leak, rumour or third-party report does not settle this. Void if {vendor} makes no announcement.",
    note: "A vendor's own channel is primary; press coverage only corroborates.",
  },
  {
    id: "opensource",
    tier: "allowed",
    minIndependentSources: 1,
    primarySourceAllowlist: ["github.com", "gitlab.com", "pypi.org", "npmjs.com", "huggingface.co"],
    maxSourceAgeSeconds: HOUR,
    resolutionWindowSeconds: HOUR,
    minDeadlineSeconds: HOUR,
    maxDeadlineSeconds: 365 * DAY,
    settlementTemplate:
      "Settle on {repository}'s public {artifact} on {source} as of {deadline} in {timezone}. Void if the repository is deleted or made private before the deadline.",
    note: "Registry state is machine-verifiable, so one source suffices.",
  },
  {
    id: "gaming",
    tier: "allowed",
    minIndependentSources: 2,
    primarySourceAllowlist: [],
    maxSourceAgeSeconds: 6 * HOUR,
    resolutionWindowSeconds: 6 * HOUR,
    minDeadlineSeconds: HOUR,
    maxDeadlineSeconds: 365 * DAY,
    settlementTemplate:
      "Settle on the official standings or result published by {organiser} for {event} on {date}, in {timezone}. Void if the event is cancelled or the format changes so the question no longer applies.",
  },
  {
    id: "entertainment",
    tier: "allowed",
    minIndependentSources: 2,
    primarySourceAllowlist: [],
    maxSourceAgeSeconds: 24 * HOUR,
    resolutionWindowSeconds: 24 * HOUR,
    minDeadlineSeconds: DAY,
    maxDeadlineSeconds: 365 * DAY,
    settlementTemplate:
      "Settle on {source}'s published {metric} for {title} covering {period}, in {timezone}. Void if {source} stops publishing that metric before the deadline.",
  },
  {
    id: "awards",
    tier: "allowed",
    minIndependentSources: 2,
    primarySourceAllowlist: [],
    maxSourceAgeSeconds: 24 * HOUR,
    resolutionWindowSeconds: 12 * HOUR,
    minDeadlineSeconds: DAY,
    maxDeadlineSeconds: 365 * DAY,
    settlementTemplate:
      "Settle on the awarding body's own announcement of {award} for {edition}, published on {source} before {deadline} in {timezone}. A nomination is not a win. Void if the award is not presented.",
  },
  {
    id: "science",
    tier: "allowed",
    minIndependentSources: 2,
    primarySourceAllowlist: ["nasa.gov", "esa.int", "noaa.gov", "arxiv.org", "nature.com"],
    maxSourceAgeSeconds: 24 * HOUR,
    resolutionWindowSeconds: 24 * HOUR,
    minDeadlineSeconds: DAY,
    maxDeadlineSeconds: 730 * DAY,
    settlementTemplate:
      "Settle on {agency}'s official confirmation of {event} published on {source} before {deadline} in {timezone}. A preprint or press release without agency confirmation does not settle this. Void if {agency} issues no confirmation by the deadline.",
  },
  {
    id: "culture",
    tier: "allowed",
    // The weakest sourcing of the wave, so it demands the most corroboration.
    minIndependentSources: 3,
    primarySourceAllowlist: [],
    maxSourceAgeSeconds: 24 * HOUR,
    resolutionWindowSeconds: 48 * HOUR,
    minDeadlineSeconds: DAY,
    maxDeadlineSeconds: 365 * DAY,
    settlementTemplate:
      "Settle on {source}'s published {metric} for {subject} covering {period}, in {timezone}. Subjective judgements do not settle this — only the published figure does. Void if the figure is not published.",
    note: "No canonical authority; requires three independent domains.",
  },

  // ── Restricted: real topics, but not for autonomous creation ──
  {
    id: "elections",
    tier: "restricted",
    minIndependentSources: 3,
    primarySourceAllowlist: [],
    maxSourceAgeSeconds: 12 * HOUR,
    resolutionWindowSeconds: 7 * DAY,
    minDeadlineSeconds: DAY,
    maxDeadlineSeconds: 730 * DAY,
    settlementTemplate:
      "Settle on the certified result published by {authority} for {contest}, in {timezone}. Projections, exit polls and media calls do not settle this. Void if certification does not occur before {deadline}.",
    note: "Regulated in many jurisdictions and a manipulation target; requires an explicit compliance decision.",
  },
  {
    id: "policy",
    tier: "restricted",
    minIndependentSources: 2,
    primarySourceAllowlist: [],
    maxSourceAgeSeconds: 12 * HOUR,
    resolutionWindowSeconds: 3 * DAY,
    minDeadlineSeconds: DAY,
    maxDeadlineSeconds: 730 * DAY,
    settlementTemplate:
      "Settle on the official record published by {institution} for {measure}, in {timezone}. Void if the measure is withdrawn or the process does not conclude before {deadline}.",
    note: "Adjacent to elections and to lobbying incentives; same compliance gate.",
  },

  // ── Blocked: not a plumbing gap ──
  {
    id: "health_outcomes",
    tier: "blocked",
    minIndependentSources: 0,
    primarySourceAllowlist: [],
    maxSourceAgeSeconds: 0,
    resolutionWindowSeconds: 0,
    minDeadlineSeconds: 0,
    maxDeadlineSeconds: 0,
    settlementTemplate: "",
    note: "Wagering on a person's medical outcome is out of scope regardless of sourcing.",
  },
  {
    id: "death_violence",
    tier: "blocked",
    minIndependentSources: 0,
    primarySourceAllowlist: [],
    maxSourceAgeSeconds: 0,
    resolutionWindowSeconds: 0,
    minDeadlineSeconds: 0,
    maxDeadlineSeconds: 0,
    settlementTemplate: "",
    note: "Creates a financial interest in someone being harmed.",
  },
  {
    id: "private_individuals",
    tier: "blocked",
    minIndependentSources: 0,
    primarySourceAllowlist: [],
    maxSourceAgeSeconds: 0,
    resolutionWindowSeconds: 0,
    minDeadlineSeconds: 0,
    maxDeadlineSeconds: 0,
    settlementTemplate: "",
    note: "Unverifiable, and a harassment vector against people who did not opt in.",
  },
  {
    id: "illegal_activity",
    tier: "blocked",
    minIndependentSources: 0,
    primarySourceAllowlist: [],
    maxSourceAgeSeconds: 0,
    resolutionWindowSeconds: 0,
    minDeadlineSeconds: 0,
    maxDeadlineSeconds: 0,
    settlementTemplate: "",
    note: "Would reward and coordinate the underlying act.",
  },
];

const BY_ID = new Map(CATEGORY_POLICIES.map((policy) => [policy.id, policy]));

export function categoryPolicy(id: string): CategoryPolicy | null {
  return BY_ID.get(id.trim().toLowerCase()) ?? null;
}

export function allowedCategories(): CategoryPolicy[] {
  return CATEGORY_POLICIES.filter((policy) => policy.tier === "allowed");
}

export function restrictedCategories(): CategoryPolicy[] {
  return CATEGORY_POLICIES.filter((policy) => policy.tier === "restricted");
}

export function blockedCategories(): CategoryPolicy[] {
  return CATEGORY_POLICIES.filter((policy) => policy.tier === "blocked");
}

/** Restricted topics need an explicit compliance opt-in, per category. */
export function isRestrictedCategoryEnabled(
  id: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[`MIMIR_COMPLIANCE_ALLOW_${id.trim().toUpperCase()}`] === "1";
}

// ── Candidate admission ───────────────────────────────────────────────────────

export type CategoryRejection =
  | "unknown_category"
  | "blocked_category"
  | "compliance_gate"
  | "too_few_sources"
  | "primary_source_not_allowed"
  | "source_too_stale"
  | "deadline_too_soon"
  | "deadline_too_far"
  | "unfilled_template";

export interface CategoryCheckResult {
  ok: boolean;
  reason?: CategoryRejection;
  detail?: string;
}

export interface CategoryCandidate {
  category: string;
  primarySourceDomain: string;
  /** Independent domains backing the claim, excluding the primary. */
  corroboratingDomains: string[];
  /** Age of the primary source's content at capture, seconds. */
  sourceAgeSeconds: number;
  /** Seconds from now until the deadline. */
  secondsUntilDeadline: number;
  settlementRule: string;
}

/**
 * Admit a candidate against its category's policy.
 *
 * Blocked is checked before anything else and has no override path: an operator
 * who sets every flag still cannot open a market on someone's medical outcome.
 */
export function checkCategory(
  candidate: CategoryCandidate,
  env: Record<string, string | undefined> = process.env,
): CategoryCheckResult {
  const policy = categoryPolicy(candidate.category);
  if (!policy) {
    recordCategoryReject("unknown_category");
    return {
      ok: false,
      reason: "unknown_category",
      detail: `'${candidate.category}' has no source policy`,
    };
  }
  if (policy.tier === "blocked") {
    recordCategoryReject("blocked_category");
    return { ok: false, reason: "blocked_category", detail: policy.note };
  }
  if (policy.tier === "restricted" && !isRestrictedCategoryEnabled(policy.id, env)) {
    recordCategoryReject("compliance_gate");
    return {
      ok: false,
      reason: "compliance_gate",
      detail: `${policy.id} requires MIMIR_COMPLIANCE_ALLOW_${policy.id.toUpperCase()}=1`,
    };
  }

  // The primary source's own domain never counts as corroboration.
  const primary = candidate.primarySourceDomain.trim().toLowerCase();
  const independent = new Set(
    candidate.corroboratingDomains
      .map((domain) => domain.trim().toLowerCase())
      .filter((domain) => domain && domain !== primary),
  );
  const total = independent.size + 1;
  if (total < policy.minIndependentSources) {
    recordCategoryReject("too_few_sources");
    return {
      ok: false,
      reason: "too_few_sources",
      detail: `${total} of ${policy.minIndependentSources} independent sources`,
    };
  }

  if (
    policy.primarySourceAllowlist.length > 0 &&
    !policy.primarySourceAllowlist.some(
      (allowed) => primary === allowed || primary.endsWith(`.${allowed}`),
    )
  ) {
    recordCategoryReject("primary_source_not_allowed");
    return {
      ok: false,
      reason: "primary_source_not_allowed",
      detail: `'${primary}' is not a recognised authority for ${policy.id}`,
    };
  }

  if (candidate.sourceAgeSeconds > policy.maxSourceAgeSeconds) {
    recordCategoryReject("source_too_stale");
    return {
      ok: false,
      reason: "source_too_stale",
      detail: `${candidate.sourceAgeSeconds}s old, limit ${policy.maxSourceAgeSeconds}s`,
    };
  }

  if (candidate.secondsUntilDeadline < policy.minDeadlineSeconds) {
    recordCategoryReject("deadline_too_soon");
    return {
      ok: false,
      reason: "deadline_too_soon",
      detail: `needs at least ${policy.minDeadlineSeconds}s`,
    };
  }
  if (candidate.secondsUntilDeadline > policy.maxDeadlineSeconds) {
    recordCategoryReject("deadline_too_far");
    return {
      ok: false,
      reason: "deadline_too_far",
      detail: `at most ${policy.maxDeadlineSeconds}s`,
    };
  }

  // An unfilled placeholder means the template was copied, not completed.
  const unfilled = candidate.settlementRule.match(/\{[a-zA-Z]+\}/g);
  if (unfilled) {
    recordCategoryReject("unfilled_template");
    return {
      ok: false,
      reason: "unfilled_template",
      detail: `unfilled placeholders: ${[...new Set(unfilled)].join(", ")}`,
    };
  }

  recordCategoryCoverage(policy.id);
  return { ok: true };
}

/** Placeholders a category's template requires, for the drafting prompt. */
export function templatePlaceholders(id: string): string[] {
  const policy = categoryPolicy(id);
  if (!policy) return [];
  const matches = policy.settlementTemplate.match(/\{([a-zA-Z]+)\}/g) ?? [];
  return [...new Set(matches.map((match) => match.slice(1, -1)))];
}
