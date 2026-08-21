/**
 * x402 v2 configuration — the single place that knows what Mimir sells, for how
 * much, and on which network.
 *
 * Network is Somnia Shannon testnet (`eip155:50312`), scheme `exact`, asset USDC. Prices
 * are dollar strings; the seller-side scheme resolves them to USDC atomic units.
 */
import { SOMNIA_CAIP2 } from "../chain";
import { parseUsdcAtomic, USDC_ADDRESS } from "../usdc";

export const X402_NETWORK = (process.env.X402_NETWORK?.trim() || SOMNIA_CAIP2) as `${string}:${string}`;
export const X402_SCHEME = "exact";
export const X402_ASSET = USDC_ADDRESS;

/**
 * Facilitator that verifies and settles payments. x402.org needs no signup and
 * is fine for testnet; staging/production should point at CDP.
 */
export const X402_FACILITATOR_URL =
  process.env.X402_FACILITATOR_URL?.trim() || "https://x402.org/facilitator";

/** Default seller — usually the oracle wallet. Persona routes override per-request. */
export function sellerAddress(payTo?: string): `0x${string}` {
  const addr = payTo ?? process.env.SELLER_ADDRESS;
  if (!addr || !addr.startsWith("0x")) {
    throw new Error("SELLER_ADDRESS is required to sell paid resources");
  }
  return addr as `0x${string}`;
}

/** Every paid endpoint's price, in dollars. Buyers read these too. */
export const PRICES = {
  premiumPrice:      "$0.001",
  oracle:            "$0.005",
  councilPreflight:  "$0.001",
  councilReasoning:  "$0.001",
  councilVote:       "$0.001",
  councilSubscribe:  "$0.01",
} as const;

export type PriceKey = keyof typeof PRICES;

/** Dollar price string -> USDC atomic units, for buyer-side budget caps. */
export function priceToUsdcUnits(price: string): bigint {
  try { return parseUsdcAtomic(price.replace(/^\$/, "")); }
  catch { throw new Error(`Invalid x402 price: ${price}`); }
}

/**
 * Bazaar discovery metadata attached to every route so agents can find these
 * services without out-of-band docs.
 */
export interface PaidResourceMeta {
  description: string;
  mimeType: string;
  serviceName: string;
  tags: string[];
  example?: { input?: unknown; output?: unknown };
}

export const RESOURCE_META: Record<PriceKey, PaidResourceMeta> = {
  premiumPrice: {
    description:
      "Premium price oracle: current reference price plus a confidence band for a supported market symbol.",
    mimeType: "application/json",
    serviceName: "Mimir Premium Price Oracle",
    tags: ["price", "oracle", "market-data"],
    example: {
      input: { symbol: "BTC" },
      output: { symbol: "BTC", price: 64000, confidence: 0.92, at: 1760000000000 },
    },
  },
  oracle: {
    description:
      "Oracle-as-a-service: submit a claim and resolution URL, get an AI verdict with confidence and a keccak256 evidence hash.",
    mimeType: "application/json",
    serviceName: "Mimir Oracle",
    tags: ["oracle", "settlement", "ai", "verdict"],
    example: {
      input: { question: "Will X ship by Friday?", resolutionUrl: "https://example.com/status" },
      output: { verdict: "CREATOR", confidence: 78, evidenceHash: "0x…" },
    },
  },
  councilPreflight: {
    description:
      "Council preflight: one persona's open/revise/skip opinion and quality score on a draft market before it is created.",
    mimeType: "application/json",
    serviceName: "Mimir Council Preflight",
    tags: ["council", "review", "market-quality"],
    example: {
      input: { question: "Will X ship by Friday?", category: "tech" },
      output: { decision: "open", score: 72, confidence: 65, reasoning: "…" },
    },
  },
  councilReasoning: {
    description:
      "Council reasoning: a single persona's written take on an open claim. Paid directly to that persona's own wallet.",
    mimeType: "application/json",
    serviceName: "Mimir Council Reasoning",
    tags: ["council", "reasoning", "persona"],
    example: {
      input: { claimId: 12, persona: "optimist" },
      output: { persona: { slug: "optimist" }, claimId: 12, reasoning: "…" },
    },
  },
  councilVote: {
    description:
      "Council vote: a single persona's structured verdict on a claim, paid directly to that persona's own wallet.",
    mimeType: "application/json",
    serviceName: "Mimir Council Vote",
    tags: ["council", "vote", "jury", "settlement"],
    example: {
      input: { claimId: 12, persona: "statistician" },
      output: { claimId: 12, verdict: "CHALLENGERS", confidence: 71, explanation: "…" },
    },
  },
  councilSubscribe: {
    description:
      "Council pass: a short-lived signed pass that unlocks council reasoning reads without a per-request payment.",
    mimeType: "application/json",
    serviceName: "Mimir Council Pass",
    tags: ["council", "pass", "subscription"],
    example: {
      input: {},
      output: { plan: "council-pass", pass: "…", expiresAt: 1760000600000, ttlMs: 600000 },
    },
  },
};
