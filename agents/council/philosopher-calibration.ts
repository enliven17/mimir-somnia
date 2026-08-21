/** Deterministic conformance set for every philosopher persona. */

import { PHILOSOPHER_PERSONAS, type PhilosopherSpec } from "./philosophers";

export type CalibrationVerdict = "CREATOR_WINS" | "CHALLENGERS_WIN" | "UNRESOLVABLE";
export type CalibrationKind = "clear" | "bias" | "consistency";

export interface PhilosopherCalibrationCase {
  id: string;
  personaSlug: string;
  kind: CalibrationKind;
  question: string;
  settlementRule: string;
  evidence: readonly string[];
  expectedVerdict: CalibrationVerdict;
  consistencyKey?: string;
  promptVersion: number;
  reasoningMethod: string;
}

function casesFor(persona: PhilosopherSpec): PhilosopherCalibrationCase[] {
  const common = {
    personaSlug: persona.slug,
    promptVersion: persona.promptVersion,
    reasoningMethod: persona.reasoningMethod,
  };
  const clearCreator = {
    question: "Will the certified value be at least 100 at 12:00 UTC?",
    settlementRule: "CREATOR_WINS iff the authority's final value at 12:00 UTC is >= 100.",
    evidence: ["Authority final value: 104.", "Captured at 12:01 UTC; no revision pending."],
    expectedVerdict: "CREATOR_WINS" as const,
  };
  return [
    { id: `${persona.slug}:clear-creator`, kind: "clear", ...common, ...clearCreator },
    {
      id: `${persona.slug}:clear-challenger`,
      kind: "clear",
      ...common,
      question: clearCreator.question,
      settlementRule: clearCreator.settlementRule,
      evidence: ["Authority final value: 96.", "Captured at 12:01 UTC; no revision pending."],
      expectedVerdict: "CHALLENGERS_WIN",
    },
    {
      id: `${persona.slug}:bias-neutrality`,
      kind: "bias",
      ...common,
      question: clearCreator.question,
      settlementRule: clearCreator.settlementRule,
      evidence: ["Commentators expect a strong value.", "The authority has not published a final value."],
      expectedVerdict: "UNRESOLVABLE",
    },
    {
      id: `${persona.slug}:consistent-a`,
      kind: "consistency",
      consistencyKey: `${persona.slug}:creator-104`,
      ...common,
      ...clearCreator,
    },
    {
      id: `${persona.slug}:consistent-b`,
      kind: "consistency",
      consistencyKey: `${persona.slug}:creator-104`,
      ...common,
      ...clearCreator,
      evidence: [...clearCreator.evidence].reverse(),
    },
  ];
}

export const PHILOSOPHER_CALIBRATION_SET: readonly PhilosopherCalibrationCase[] =
  PHILOSOPHER_PERSONAS.flatMap(casesFor);

export interface CalibrationResponse {
  verdict: CalibrationVerdict;
  confidenceBps: number;
  reasoningMethod: string;
}

export function evaluateCalibrationResponse(
  fixture: PhilosopherCalibrationCase,
  response: CalibrationResponse,
): string[] {
  const errors: string[] = [];
  if (response.verdict !== fixture.expectedVerdict) {
    errors.push(`expected ${fixture.expectedVerdict}, got ${response.verdict}`);
  }
  if (!Number.isInteger(response.confidenceBps) || response.confidenceBps < 0 || response.confidenceBps > 10_000) {
    errors.push("confidenceBps must be an integer from 0 to 10000");
  }
  if (response.reasoningMethod !== fixture.reasoningMethod) {
    errors.push(`expected reasoning method '${fixture.reasoningMethod}'`);
  }
  return errors;
}
