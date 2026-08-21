/**
 * What to do when a resolution source is gone, or no longer says what it said
 * (§10.2, last item).
 *
 * A market's primary source is fetched twice in its life: once when the market is
 * created and the content is hashed, and once at settlement. Between those two
 * moments a page can 404, move behind a paywall, or quietly change its numbers
 * under the same URL. Each of those is a different problem and only one of them is
 * "the market cannot be settled".
 *
 * The rules, in order:
 *
 *  1. **Same URL, same hash → settle.** The evidence is the evidence.
 *  2. **Same URL, different hash → do NOT silently accept it.** A source that
 *     changed after the deadline may have been corrected, back-dated, or
 *     tampered with. A corroborating source has to agree before it counts, and if
 *     none does, the market is unresolvable rather than settled on a number
 *     nobody can verify.
 *  3. **Primary unavailable → fall back in trust order**, primary tier first,
 *     never to an unverified source. A fallback settlement is flagged as such, so
 *     it is auditable rather than indistinguishable from a clean one.
 *  4. **Nothing usable → void per the pack's own void rule**, not per a guess. If
 *     the pack declared no void rule, that is unresolvable: inventing a void rule
 *     at settlement time is deciding the market after the fact.
 *
 * Pure: the caller does the fetching, this decides what the fetches mean.
 */

import type { ContextSource, MarketContextPack, TrustTier } from "./context-pack";

/** The outcome of trying to fetch one source at settlement time. */
export interface SourceProbe {
  url: string;
  /** Reachable and returned usable content. */
  available: boolean;
  /** Hash of what came back now. Absent when unavailable. */
  contentHash?: string;
  /** HTTP status or failure reason, for the audit trail. */
  detail?: string;
}

export type FallbackDecision =
  /** Primary source intact — settle on it. */
  | "settle_primary"
  /** Primary changed but a corroborating source agrees — settle, flagged. */
  | "settle_corroborated"
  /** Primary gone; a trusted corroborating source stands in — settle, flagged. */
  | "settle_fallback"
  /** The pack's declared void rule applies. */
  | "void_per_rule"
  /** Nothing usable and no declared void rule. */
  | "unresolvable";

export interface FallbackOutcome {
  decision: FallbackDecision;
  /** The source the settlement should cite. */
  citedUrl: string | null;
  /** True whenever the settlement did not use the intact primary source. */
  degraded: boolean;
  /** One line for the settlement record. */
  reason: string;
  /** Sources probed and what happened, for the audit trail. */
  probed: Array<{ url: string; available: boolean; hashMatched: boolean | null }>;
}

/** Tiers that may stand in for a missing primary, best first. */
const FALLBACK_TIER_ORDER: TrustTier[] = ["primary", "corroborating"];

function tierRank(tier: TrustTier): number {
  const index = FALLBACK_TIER_ORDER.indexOf(tier);
  // An unverified source is never a fallback: it is exactly the kind of source
  // somebody could stand up specifically to settle a market their way.
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

function probeFor(probes: SourceProbe[], url: string): SourceProbe | undefined {
  const key = url.trim().toLowerCase();
  return probes.find((p) => p.url.trim().toLowerCase() === key);
}

function hashesMatch(expected: string, actual: string | undefined): boolean {
  if (!actual) return false;
  return expected.trim().toLowerCase() === actual.trim().toLowerCase();
}

export function decideSourceFallback(
  pack: MarketContextPack,
  probes: SourceProbe[],
): FallbackOutcome {
  const primary = pack.primarySource;
  const primaryProbe = probeFor(probes, primary.url);

  const audit: FallbackOutcome["probed"] = [];
  const note = (source: ContextSource, probe: SourceProbe | undefined) => {
    audit.push({
      url: source.url,
      available: probe?.available === true,
      hashMatched: probe?.available ? hashesMatch(source.contentHash, probe.contentHash) : null,
    });
  };
  note(primary, primaryProbe);

  // Rank the corroborating sources once; used by both the changed-primary and
  // missing-primary paths so the two cannot disagree about what is trustworthy.
  const usableCorroborating = pack.corroboratingSources
    .filter((source) => tierRank(source.trustTier) !== Number.POSITIVE_INFINITY)
    .sort((a, b) => tierRank(a.trustTier) - tierRank(b.trustTier) || a.url.localeCompare(b.url));

  for (const source of usableCorroborating) {
    if (source.url !== primary.url) note(source, probeFor(probes, source.url));
  }

  if (primaryProbe?.available) {
    if (hashesMatch(primary.contentHash, primaryProbe.contentHash)) {
      return {
        decision: "settle_primary",
        citedUrl: primary.url,
        degraded: false,
        reason: "primary source intact and unchanged",
        probed: audit,
      };
    }

    // Rule 2: changed content needs independent agreement. Note this checks the
    // corroborating source's OWN recorded hash — a source that also changed is not
    // corroboration, it is a second unknown.
    const agreeing = usableCorroborating.find((source) => {
      const probe = probeFor(probes, source.url);
      return probe?.available && hashesMatch(source.contentHash, probe.contentHash);
    });
    if (agreeing) {
      return {
        decision: "settle_corroborated",
        citedUrl: agreeing.url,
        degraded: true,
        reason: `primary source content changed since capture; corroborated by ${agreeing.domain}`,
        probed: audit,
      };
    }
    return voidOrUnresolvable(
      pack,
      "primary source content changed since capture and no source corroborates it",
      audit,
    );
  }

  // Rule 3: primary unavailable — fall back in trust order, verifying the stand-in
  // against its own captured hash. An available-but-changed fallback is no better
  // than a changed primary.
  const standIn = usableCorroborating.find((source) => {
    const probe = probeFor(probes, source.url);
    return probe?.available && hashesMatch(source.contentHash, probe.contentHash);
  });
  if (standIn) {
    return {
      decision: "settle_fallback",
      citedUrl: standIn.url,
      degraded: true,
      reason: `primary source unavailable (${primaryProbe?.detail ?? "no response"}); settled on ${standIn.domain}`,
      probed: audit,
    };
  }

  return voidOrUnresolvable(
    pack,
    `primary source unavailable (${primaryProbe?.detail ?? "no response"}) and no verifiable fallback`,
    audit,
  );
}

/**
 * Rule 4. A void rule declared BEFORE the market opened is a rule the
 * participants agreed to; one invented at settlement time is deciding the market
 * after the fact, so its absence is unresolvable rather than a default void.
 */
function voidOrUnresolvable(
  pack: MarketContextPack,
  reason: string,
  probed: FallbackOutcome["probed"],
): FallbackOutcome {
  const voidRule = pack.resolution.voidRule?.trim();
  if (voidRule) {
    return {
      decision: "void_per_rule",
      citedUrl: null,
      degraded: true,
      reason: `${reason}; applying the declared void rule`,
      probed,
    };
  }
  return {
    decision: "unresolvable",
    citedUrl: null,
    degraded: true,
    reason: `${reason}; no void rule was declared`,
    probed,
  };
}

/** True when a settlement should carry a "degraded evidence" marker to readers. */
export function isDegradedSettlement(outcome: FallbackOutcome): boolean {
  return outcome.degraded;
}
