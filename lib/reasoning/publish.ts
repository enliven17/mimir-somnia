/**
 * The one write path for agent reasoning.
 *
 * Every publication goes through here so the safety pass cannot be skipped by a
 * new caller: validate the shape, run the content checks, then persist — with the
 * safety findings stored alongside the row so a withheld event is explainable
 * after the fact instead of just missing.
 */

import "server-only";
import { insertReasoningEvent } from "../db";
import { decidePublication, type SafetyFinding } from "./redact";
import {
  REASONING_SCHEMA_VERSION,
  evidenceDomain,
  freshnessSeconds,
  reasoningEventId,
  validateReasoningEvent,
  type EvidenceRef,
  type ReasoningEvent,
  type ReasoningPosition,
  type ReasoningStage,
} from "./schema";

export interface PublishReasoningInput {
  claimId: number;
  agentId: string;
  track: ReasoningEvent["track"];
  stage: ReasoningStage;
  position: ReasoningPosition;
  confidenceBps: number;
  summary: string;
  uncertainty: string;
  evidenceRefs: Array<Omit<EvidenceRef, "domain" | "freshnessSeconds">>;
  model?: string;
  provider?: string;
  promptVersion?: number;
  paymentIdentifier?: string;
  /** Distinguishes several legitimate events of one stage, e.g. peer replies. */
  sequence?: number;
  at?: number;
}

export type PublishOutcome =
  | { published: true; eventId: string; visibility: "public" }
  | { published: false; eventId: string; reason: "invalid"; errors: string[] }
  | { published: false; eventId: string; reason: "withheld"; findings: SafetyFinding[] };

/**
 * Validate, safety-check and persist one reasoning event.
 *
 * A withheld event is still WRITTEN, with visibility 'withheld' and its findings
 * attached. Dropping it silently would hide the fact that an agent produced
 * unpublishable output — which is exactly the signal an operator needs.
 */
export async function publishReasoning(input: PublishReasoningInput): Promise<PublishOutcome> {
  const eventId = reasoningEventId({
    claimId: input.claimId,
    agentId: input.agentId,
    stage: input.stage,
    sequence: input.sequence,
  });
  const createdAt = input.at ?? Date.now();

  // Derive the display fields rather than trusting a caller to fill them in.
  const evidenceRefs: EvidenceRef[] = input.evidenceRefs.map((ref) => ({
    ...ref,
    domain: evidenceDomain(ref.url),
    freshnessSeconds: freshnessSeconds(ref),
  }));

  const event: ReasoningEvent = {
    eventId,
    schemaVersion: REASONING_SCHEMA_VERSION,
    claimId: input.claimId,
    agentId: input.agentId,
    track: input.track,
    stage: input.stage,
    position: input.position,
    confidenceBps: input.confidenceBps,
    summary: input.summary.trim(),
    uncertainty: input.uncertainty.trim(),
    evidenceRefs,
    model: input.model,
    provider: input.provider,
    promptVersion: input.promptVersion,
    paymentIdentifier: input.paymentIdentifier,
    visibility: "public",
    createdAt,
  };

  const validation = validateReasoningEvent(event);
  if (!validation.ok) {
    // A malformed event is a bug in the producer; do not persist a broken row.
    return { published: false, eventId, reason: "invalid", errors: validation.errors };
  }

  const decision = decidePublication(event);
  const row = {
    event_id: eventId,
    schema_version: event.schemaVersion,
    claim_id: event.claimId,
    agent_id: event.agentId,
    track: event.track,
    stage: event.stage,
    position: event.position,
    confidence_bps: event.confidenceBps,
    summary: event.summary,
    uncertainty: event.uncertainty,
    evidence_refs_json: JSON.stringify(evidenceRefs),
    model: event.model ?? null,
    provider: event.provider ?? null,
    prompt_version: event.promptVersion ?? null,
    payment_identifier: event.paymentIdentifier ?? null,
    visibility: decision.visibility,
    safety_findings_json: JSON.stringify(decision.findings),
    created_at: createdAt,
  };

  try {
    await insertReasoningEvent(row);
  } catch (err) {
    // Reasoning is a product surface, not a financial record: a feed write must
    // not break a settlement. Surface it as unpublished and move on.
    console.warn(
      "[reasoning] persist failed:",
      err instanceof Error ? err.message : err,
    );
    return { published: false, eventId, reason: "invalid", errors: ["persist failed"] };
  }

  if (decision.visibility === "withheld") {
    return { published: false, eventId, reason: "withheld", findings: decision.findings };
  }
  return { published: true, eventId, visibility: "public" };
}
