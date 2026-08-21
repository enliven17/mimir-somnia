/**
 * The agent metadata document (§7.1).
 *
 * `AgentRecord` holds what the platform enforces — wallets, capabilities, limits,
 * status. This is the part the agent's owner writes about itself: who it is, how it
 * reasons, which sources it will use, which model is behind it.
 *
 * It is deliberately a separate document with its own hash, for one reason: it is
 * self-asserted. Nothing here is verified, so it must never be readable as a
 * permission. `metadataHash` on the record lets a reader tell that the document
 * changed since it was registered, which is the only integrity claim available
 * about text somebody wrote about themselves.
 *
 * The disclosures are required rather than optional because their ABSENCE is the
 * useful signal. An agent that will not say which model it runs, or will not say
 * whether a human reviews its decisions, has told you something — and an optional
 * field would let that silence look identical to a document nobody finished.
 */

export const AGENT_METADATA_VERSION = 1;

/** How an agent handles the reasoning it publishes. */
export type ReasoningPolicy =
  /** Publishes a public summary for every decision. */
  | "always_public"
  /** Publishes a summary, sells the detail over x402. */
  | "summary_public_detail_paid"
  /** Publishes nothing; decisions are visible only as positions. */
  | "none";

/** What an agent will read before deciding. */
export type SourcePolicy =
  /** Only the market's declared resolution source. */
  | "declared_source_only"
  /** The declared source plus corroborating sources it fetches itself. */
  | "declared_plus_corroborating"
  /** Also buys third-party research over x402. */
  | "includes_paid_research";

/** Whether a human is in the loop. */
export type HumanOversight =
  /** Every action is reviewed by a person before it happens. */
  | "reviewed_before_action"
  /** A person reviews afterwards and can intervene. */
  | "reviewed_after_action"
  /** Fully autonomous. */
  | "none";

export interface AgentMetadata {
  version: number;
  name: string;
  description: string;
  /** Absolute https URL. Optional: an agent with no picture is still an agent. */
  avatarUrl?: string;
  reasoningPolicy: ReasoningPolicy;
  sourcePolicy: SourcePolicy;
  /**
   * Model and provider, as the owner declares them. Unverified — an agent can
   * lie here, and a reader should treat it as a claim, not a fact.
   */
  modelDisclosure: string;
  humanOversight: HumanOversight;
  /** How to reach the operator. Email or URL. */
  contact: string;
  /** Terms the owner publishes for anyone copying or paying this agent. */
  termsUrl?: string;
  /** Optional Basename or ENS name. A label, never an identity check. */
  basename?: string;
}

export const MAX_NAME_CHARS = 60;
export const MAX_DESCRIPTION_CHARS = 600;
export const MAX_MODEL_DISCLOSURE_CHARS = 200;

export interface MetadataValidation {
  ok: boolean;
  errors: string[];
  /** Non-fatal notes a UI should surface next to the profile. */
  warnings: string[];
}

const REASONING_POLICIES: ReasoningPolicy[] = [
  "always_public",
  "summary_public_detail_paid",
  "none",
];
const SOURCE_POLICIES: SourcePolicy[] = [
  "declared_source_only",
  "declared_plus_corroborating",
  "includes_paid_research",
];
const OVERSIGHT: HumanOversight[] = [
  "reviewed_before_action",
  "reviewed_after_action",
  "none",
];

/** https only, and no credentials — a profile URL is shown to strangers. */
function httpsUrlError(field: string, value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${field} must be an absolute URL`;
  }
  if (url.protocol !== "https:") return `${field} must use https`;
  if (url.username || url.password) return `${field} must not carry credentials`;
  return null;
}

export function validateAgentMetadata(metadata: AgentMetadata): MetadataValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (metadata.version !== AGENT_METADATA_VERSION) {
    errors.push(`version must be ${AGENT_METADATA_VERSION}`);
  }

  const name = metadata.name?.trim() ?? "";
  if (name.length === 0) errors.push("name is required");
  if (name.length > MAX_NAME_CHARS) errors.push(`name must be at most ${MAX_NAME_CHARS} characters`);
  // A name that is only look-alike or invisible characters renders as blank or as
  // another agent's name in a list.
  if (name.length > 0 && !/[\p{L}\p{N}]/u.test(name)) {
    errors.push("name must contain a letter or a number");
  }

  const description = metadata.description?.trim() ?? "";
  if (description.length === 0) errors.push("description is required");
  if (description.length > MAX_DESCRIPTION_CHARS) {
    errors.push(`description must be at most ${MAX_DESCRIPTION_CHARS} characters`);
  }

  if (!REASONING_POLICIES.includes(metadata.reasoningPolicy)) {
    errors.push("reasoningPolicy is required");
  }
  if (!SOURCE_POLICIES.includes(metadata.sourcePolicy)) {
    errors.push("sourcePolicy is required");
  }
  if (!OVERSIGHT.includes(metadata.humanOversight)) {
    errors.push("humanOversight is required");
  }

  const model = metadata.modelDisclosure?.trim() ?? "";
  if (model.length === 0) {
    // Required, because its absence is the signal.
    errors.push("modelDisclosure is required");
  } else if (model.length > MAX_MODEL_DISCLOSURE_CHARS) {
    errors.push(`modelDisclosure must be at most ${MAX_MODEL_DISCLOSURE_CHARS} characters`);
  }

  const contact = metadata.contact?.trim() ?? "";
  if (contact.length === 0) errors.push("contact is required");

  for (const [field, value] of [
    ["avatarUrl", metadata.avatarUrl],
    ["termsUrl", metadata.termsUrl],
  ] as const) {
    if (!value) continue;
    const error = httpsUrlError(field, value);
    if (error) errors.push(error);
  }

  // Warnings, not errors: these are choices an owner may legitimately make, and a
  // reader should see them rather than be prevented from reading the profile.
  if (metadata.reasoningPolicy === "none") {
    warnings.push("this agent publishes no reasoning for its decisions");
  }
  if (metadata.humanOversight === "none") {
    warnings.push("this agent acts without human review");
  }
  if (!metadata.termsUrl) {
    warnings.push("no terms published for copying or paying this agent");
  }
  if (metadata.basename) {
    // Said every time, because a name that looks official is exactly what a
    // reader will over-trust.
    warnings.push("the basename is a label the owner set, not a verified identity");
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Canonical JSON for hashing.
 *
 * Keys in a fixed order and no incidental whitespace, so the same document always
 * hashes the same — a hash that depends on key insertion order would flag an edit
 * that never happened.
 */
export function canonicalMetadataJson(metadata: AgentMetadata): string {
  return JSON.stringify([
    metadata.version,
    metadata.name.trim(),
    metadata.description.trim(),
    metadata.avatarUrl ?? "",
    metadata.reasoningPolicy,
    metadata.sourcePolicy,
    metadata.modelDisclosure.trim(),
    metadata.humanOversight,
    metadata.contact.trim(),
    metadata.termsUrl ?? "",
    metadata.basename?.trim().toLowerCase() ?? "",
  ]);
}

/**
 * Disclosures a reader should be shown before copying or paying an agent.
 *
 * Returned as a list rather than a paragraph so a UI cannot render only the
 * flattering half.
 */
export function disclosureSummary(metadata: AgentMetadata): string[] {
  return [
    `Model: ${metadata.modelDisclosure.trim() || "not disclosed"}`,
    `Reasoning: ${metadata.reasoningPolicy.replace(/_/g, " ")}`,
    `Sources: ${metadata.sourcePolicy.replace(/_/g, " ")}`,
    `Human oversight: ${metadata.humanOversight.replace(/_/g, " ")}`,
  ];
}
