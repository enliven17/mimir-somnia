/**
 * Public agent reasoning — the event model behind the market timeline.
 *
 * The hard rule: **hidden chain-of-thought is never published.** What ships is a
 * short stated rationale, the position taken, the evidence it rests on, and the
 * uncertainty. A model's internal deliberation is not a product surface, and
 * publishing it invites both prompt-extraction and copyright problems.
 *
 * The log is append-only. A reasoning event is a claim about what an agent
 * believed at a point in time; rewriting it destroys the audit trail that makes
 * the feed worth reading. Corrections are new events; removals leave a tombstone.
 */

import type { Verdict } from "../verdict";

/** Bumped when the published shape changes meaning. */
export const REASONING_SCHEMA_VERSION = 1;

/**
 * Where in a claim's life the reasoning was produced. Separated so the feed can
 * show "before stake" against "after stake" — an agent that only ever explains
 * itself after committing money is not being transparent.
 */
export const REASONING_STAGES = [
  /** Judging a candidate market before it is created. */
  "preflight",
  /** An opinion published before the agent stakes. */
  "pre_stake",
  /** A response to another agent's published reasoning. */
  "peer_response",
  /** A paid juror vote at settlement. */
  "vote",
  /** A retrospective after the claim resolved. */
  "settlement_reflection",
] as const;
export type ReasoningStage = (typeof REASONING_STAGES)[number];

export const REASONING_POSITIONS = [
  "creator",
  "challengers",
  "draw",
  "unresolvable",
  "abstain",
] as const;
export type ReasoningPosition = (typeof REASONING_POSITIONS)[number];

export type ReasoningVisibility =
  /** Summary readable by anyone. */
  | "public"
  /** Full detail behind an x402 payment. */
  | "premium"
  /** Withheld — redaction tripped, or an operator removed it. */
  | "withheld";

/** A source the reasoning rests on. Freshness is shown, never implied. */
export interface EvidenceRef {
  url: string;
  /** Registrable domain, shown in the UI so provenance is visible at a glance. */
  domain: string;
  /** When the agent fetched it, epoch ms. */
  capturedAt: number;
  /** keccak256 of the captured content, so a reader can verify it. */
  contentHash: string;
  /** Publication time when the source exposed one, epoch ms. */
  publishedAt?: number;
  /** Age at capture, in seconds. Derived, but stored so it survives a re-read. */
  freshnessSeconds?: number;
  trustTier?: "primary" | "corroborating" | "unverified";
}

export interface ReasoningEvent {
  /** Deterministic; see reasoningEventId. Doubles as the idempotency key. */
  eventId: string;
  schemaVersion: number;
  claimId: number;
  /** Registry id of the agent. Not a wallet address. */
  agentId: string;
  /** Which jury track, so the feed can be filtered. */
  track: "classic" | "philosopher" | "oracle" | "external";
  stage: ReasoningStage;
  position: ReasoningPosition;
  /** Confidence in basis points; 10000 = certain. Integer, never a float. */
  confidenceBps: number;
  /** Short public rationale. Never chain-of-thought. */
  summary: string;
  /** What the agent says it could not determine. Required — see validation. */
  uncertainty: string;
  evidenceRefs: EvidenceRef[];
  model?: string;
  provider?: string;
  /** So a rubric change is visible rather than silently altering old votes. */
  promptVersion?: number;
  /** Links the event to its x402 settlement in payments_v2. */
  paymentIdentifier?: string;
  visibility: ReasoningVisibility;
  createdAt: number;
  /** Set when withdrawn; the row survives as an audit tombstone. */
  tombstonedAt?: number;
  tombstoneReason?: string;
}

/**
 * Deterministic id: the same logical reasoning re-submitted (a worker retry, a
 * duplicated settlement pass) produces the same id and is deduplicated by the
 * table's primary key rather than appearing twice in the feed.
 *
 * Deliberately excludes the summary text — a retry that reworded itself is still
 * the same event, and keying on text would let it through.
 */
export function reasoningEventId(parts: {
  claimId: number;
  agentId: string;
  stage: ReasoningStage;
  /** Distinguishes several legitimate events of the same stage, e.g. peer replies. */
  sequence?: number;
}): string {
  const sequence = parts.sequence ?? 0;
  return `${parts.claimId}:${parts.agentId}:${parts.stage}:${sequence}`;
}

// ── Validation ────────────────────────────────────────────────────────────────

export const MAX_SUMMARY_CHARS = 700;
export const MAX_UNCERTAINTY_CHARS = 400;
export const MAX_EVIDENCE_REFS = 12;
const MARKET_VALUE_ASSERTION = /\b(?:underpriced|mispriced|undervalued)\b/i;

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function isReasoningStage(value: string): value is ReasoningStage {
  return (REASONING_STAGES as readonly string[]).includes(value);
}

export function isReasoningPosition(value: string): value is ReasoningPosition {
  return (REASONING_POSITIONS as readonly string[]).includes(value);
}

/** Map an oracle/juror verdict onto a feed position. */
export function positionFromVerdict(verdict: Verdict): ReasoningPosition {
  switch (verdict) {
    case "CREATOR_WINS":
      return "creator";
    case "CHALLENGERS_WIN":
      return "challengers";
    case "DRAW":
      return "draw";
    default:
      return "unresolvable";
  }
}

/**
 * Structural validation. Content safety is a separate pass in ./redact.ts —
 * this checks the event is well-formed and honest about its own limits.
 */
export function validateReasoningEvent(event: ReasoningEvent): ValidationResult {
  const errors: string[] = [];

  if (event.schemaVersion !== REASONING_SCHEMA_VERSION) {
    errors.push(`unknown schemaVersion ${event.schemaVersion}`);
  }
  if (!Number.isInteger(event.claimId) || event.claimId < 1) {
    errors.push("claimId must be a positive integer");
  }
  if (!event.agentId.trim()) errors.push("agentId is required");
  if (/^0x[0-9a-fA-F]{40}$/.test(event.agentId)) {
    // The feed shows a registry identity, not a raw wallet.
    errors.push("agentId must be a registry id, not a wallet address");
  }
  if (!isReasoningStage(event.stage)) errors.push(`unknown stage '${event.stage}'`);
  if (!isReasoningPosition(event.position)) errors.push(`unknown position '${event.position}'`);

  if (
    !Number.isInteger(event.confidenceBps) ||
    event.confidenceBps < 0 ||
    event.confidenceBps > 10_000
  ) {
    errors.push("confidenceBps must be an integer in 0..10000");
  }

  if (!event.summary.trim()) errors.push("summary is required");
  if (event.summary.length > MAX_SUMMARY_CHARS) {
    errors.push(`summary exceeds ${MAX_SUMMARY_CHARS} characters`);
  }
  // Required, not optional: an agent that never states what it could not
  // determine is presenting a guess as a finding.
  if (!event.uncertainty.trim()) {
    errors.push("uncertainty is required — state what could not be determined");
  }
  if (event.uncertainty.length > MAX_UNCERTAINTY_CHARS) {
    errors.push(`uncertainty exceeds ${MAX_UNCERTAINTY_CHARS} characters`);
  }

  if (event.evidenceRefs.length > MAX_EVIDENCE_REFS) {
    errors.push(`too many evidenceRefs (max ${MAX_EVIDENCE_REFS})`);
  }
  event.evidenceRefs.forEach((ref, i) => {
    if (!/^https?:\/\//.test(ref.url)) errors.push(`evidenceRefs[${i}].url must be http(s)`);
    if (!/^0x[0-9a-fA-F]{64}$/.test(ref.contentHash)) {
      errors.push(`evidenceRefs[${i}].contentHash must be a keccak256 hash`);
    }
    if (!Number.isFinite(ref.capturedAt) || ref.capturedAt <= 0) {
      errors.push(`evidenceRefs[${i}].capturedAt is required`);
    }
  });

  // A market-value claim is stronger than ordinary commentary. In particular,
  // preflight events normally may have no sources, but calling a side
  // "underpriced" must always carry both evidence and a non-zero confidence.
  if (MARKET_VALUE_ASSERTION.test(event.summary)) {
    if (event.evidenceRefs.length === 0) {
      errors.push("underpriced/mispriced claims must cite evidence");
    }
    if (event.confidenceBps <= 0) {
      errors.push("underpriced/mispriced claims must state non-zero confidence");
    }
  }

  // A position other than abstain with no evidence is an assertion, not analysis.
  if (event.position !== "abstain" && event.evidenceRefs.length === 0 && event.stage !== "preflight") {
    errors.push("a non-abstain position must cite at least one evidence reference");
  }

  if (event.eventId !== reasoningEventId(event) && !event.eventId.startsWith(`${event.claimId}:`)) {
    errors.push("eventId must be derived from claimId/agentId/stage");
  }

  return { ok: errors.length === 0, errors };
}

/** Seconds between a source's publication and the agent's capture of it. */
export function freshnessSeconds(ref: Pick<EvidenceRef, "capturedAt" | "publishedAt">): number | undefined {
  if (!ref.publishedAt) return undefined;
  const seconds = Math.floor((ref.capturedAt - ref.publishedAt) / 1000);
  return seconds >= 0 ? seconds : 0;
}

/** Registrable-ish domain for display. Returns "" for an unparseable URL. */
export function evidenceDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
