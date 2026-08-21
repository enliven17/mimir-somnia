/**
 * Admission control for x402 Bazaar discovery (§10.1).
 *
 * Discovery tells an agent that some endpoint exists, advertises a capability and
 * names a price. None of that is evidence that it is safe to call or honest about
 * what it returns — the listing is written by the seller. So a discovered endpoint
 * is treated as an untrusted claim until it passes this filter, and the roadmap's
 * rule is explicit: **never automatically trust a discovered endpoint.**
 *
 * What the filter enforces:
 *
 *   1. The URL survives the same SSRF checks as any other agent fetch. A Bazaar
 *      listing pointing at 169.254.169.254 is the cheapest possible attack.
 *   2. The advertised price is inside a hard cap AND is a price we can parse. An
 *      unparseable or absent price is a refusal, not a free call.
 *   3. The capability is one we asked for. An endpoint advertising forty tags is
 *      matching keywords, not offering a service.
 *   4. The host is on an allowlist when one is configured. Discovery widens reach;
 *      an operator has to be able to narrow it again without a deploy.
 *
 * Everything here is pure so the decisions are testable without a network.
 */

import { checkUrl, checkDomainPolicy, type DomainPolicy } from "@/lib/research/ssrf";
import { parseUsdcAtomic } from "@/lib/usdc";

/** A Bazaar listing as advertised by its seller. Every field is untrusted. */
export interface DiscoveredResource {
  url: string;
  /** Dollar string as advertised, e.g. "$0.001". */
  price?: string;
  capabilities?: string[];
  serviceName?: string;
  mimeType?: string;
}

export type DiscoveryRejection =
  | "unsafe_url"
  | "domain_not_allowed"
  | "price_missing"
  | "price_unparseable"
  | "price_above_cap"
  | "capability_not_requested"
  | "too_many_capabilities"
  | "mime_not_accepted";

export interface DiscoveryVerdict {
  admitted: boolean;
  reason?: DiscoveryRejection;
  detail?: string;
  /** Parsed price in USDC atomic units, present only when admitted. */
  priceUnits?: bigint;
}

export interface DiscoveryPolicy {
  /** Hard ceiling per call, in USDC atomic units. */
  maxPriceUnits: bigint;
  /** Capabilities the caller actually wants. Empty means "refuse everything". */
  wantedCapabilities: string[];
  /**
   * Upper bound on advertised capabilities.
   *
   * A listing claiming to do everything is keyword-matching for discovery traffic,
   * not describing a service.
   */
  maxAdvertisedCapabilities: number;
  domainPolicy?: DomainPolicy;
  acceptedMimeTypes?: string[];
}

export const DEFAULT_MAX_ADVERTISED_CAPABILITIES = 8;

/**
 * Parse an advertised dollar price into atomic units.
 *
 * Returns null rather than throwing, and rejects anything that is not a plain
 * decimal — "free", "0.001 ETH" and "1e9" are all refusals. A seller controls this
 * string, so a lenient parse is a way to be charged a number nobody read.
 */
export function parseAdvertisedPrice(price: string | undefined): bigint | null {
  if (typeof price !== "string") return null;
  const trimmed = price.trim();
  if (!/^\$?\d+(\.\d{1,6})?$/.test(trimmed)) return null;
  try { return parseUsdcAtomic(trimmed.replace(/^\$/, "")); }
  catch { return null; }
}

export function admitDiscovered(
  resource: DiscoveredResource,
  policy: DiscoveryPolicy,
): DiscoveryVerdict {
  // URL safety first: a rejected host means nothing else about the listing matters.
  const urlVerdict = checkUrl(resource.url);
  if (!urlVerdict.allowed) {
    return { admitted: false, reason: "unsafe_url", detail: urlVerdict.detail ?? urlVerdict.reason };
  }

  if (policy.domainPolicy) {
    const domainVerdict = checkDomainPolicy(resource.url, policy.domainPolicy);
    if (!domainVerdict.allowed) {
      return {
        admitted: false,
        reason: "domain_not_allowed",
        detail: domainVerdict.detail ?? domainVerdict.reason,
      };
    }
  }

  if (resource.price === undefined || resource.price === null) {
    // An endpoint that does not say what it costs is not free; it is unpriced.
    return { admitted: false, reason: "price_missing" };
  }
  const priceUnits = parseAdvertisedPrice(resource.price);
  if (priceUnits === null) {
    return { admitted: false, reason: "price_unparseable", detail: resource.price };
  }
  if (priceUnits > policy.maxPriceUnits) {
    return {
      admitted: false,
      reason: "price_above_cap",
      detail: `${priceUnits} > ${policy.maxPriceUnits}`,
    };
  }

  const advertised = (resource.capabilities ?? []).map((c) => c.trim().toLowerCase()).filter(Boolean);
  const limit = policy.maxAdvertisedCapabilities ?? DEFAULT_MAX_ADVERTISED_CAPABILITIES;
  if (advertised.length > limit) {
    return {
      admitted: false,
      reason: "too_many_capabilities",
      detail: `${advertised.length} > ${limit}`,
    };
  }
  const wanted = policy.wantedCapabilities.map((c) => c.trim().toLowerCase()).filter(Boolean);
  // An empty wanted list refuses everything rather than admitting everything: a
  // misconfigured policy must fail closed.
  if (wanted.length === 0 || !advertised.some((c) => wanted.includes(c))) {
    return { admitted: false, reason: "capability_not_requested" };
  }

  if (policy.acceptedMimeTypes && policy.acceptedMimeTypes.length > 0) {
    const mime = (resource.mimeType ?? "").trim().toLowerCase();
    if (!policy.acceptedMimeTypes.map((m) => m.toLowerCase()).includes(mime)) {
      return { admitted: false, reason: "mime_not_accepted", detail: mime || "(none)" };
    }
  }

  return { admitted: true, priceUnits };
}

/**
 * Filter a discovery response.
 *
 * Returns admitted resources and the rejections, so a caller can log WHY reach
 * narrowed instead of silently seeing fewer sources.
 */
export function admitDiscoveredBatch(
  resources: DiscoveredResource[],
  policy: DiscoveryPolicy,
): {
  admitted: Array<DiscoveredResource & { priceUnits: bigint }>;
  rejected: Array<{ resource: DiscoveredResource; verdict: DiscoveryVerdict }>;
} {
  const admitted: Array<DiscoveredResource & { priceUnits: bigint }> = [];
  const rejected: Array<{ resource: DiscoveredResource; verdict: DiscoveryVerdict }> = [];
  const seen = new Set<string>();

  for (const resource of resources) {
    const verdict = admitDiscovered(resource, policy);
    if (!verdict.admitted || verdict.priceUnits === undefined) {
      rejected.push({ resource, verdict });
      continue;
    }
    // A listing repeated under two names is one endpoint. Deduplicating by URL
    // stops a seller filling the whole result set with itself.
    const key = resource.url.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    admitted.push({ ...resource, priceUnits: verdict.priceUnits });
  }

  // Cheapest first: with equal capability there is no reason to pay more, and a
  // stable order keeps a retry from picking a different endpoint.
  admitted.sort((a, b) =>
    a.priceUnits === b.priceUnits
      ? a.url.localeCompare(b.url)
      : a.priceUnits < b.priceUnits
        ? -1
        : 1,
  );
  return { admitted, rejected };
}
