import { keccak256, toBytes } from "viem";

export const AGENT_API_VERSION = "v1";
export const AGENT_API_ACTIONS = [
  "register", "heartbeat", "proposeMarket", "createMarket", "publishReasoning",
  "vote", "stake", "listPositions", "listEarnings", "revoke", "dryRun",
  // Credential and budget management. issueKey/revokeKey and grantSpend are
  // owner-signed; the rest an agent may call with its own key.
  "issueKey", "listKeys", "revokeKey", "grantSpend", "revokeSpend", "spendStatus",
] as const;
export type AgentApiAction = (typeof AGENT_API_ACTIONS)[number];

export interface SignedAgentRequest<T = unknown> {
  version: typeof AGENT_API_VERSION;
  agentId: string;
  action: AgentApiAction;
  idempotencyKey: string;
  nonce: string;
  signedAt: number;
  body: T;
  signature: `0x${string}`;
}

export const AGENT_REQUEST_MAX_SKEW_MS = 5 * 60_000;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function agentRequestMessage(request: Omit<SignedAgentRequest, "signature">): string {
  const bodyHash = keccak256(toBytes(stable(request.body)));
  return [
    "Mimir Agent API request", `version: ${request.version}`, `agent: ${request.agentId}`,
    `action: ${request.action}`, `idempotency: ${request.idempotencyKey}`,
    `nonce: ${request.nonce}`, `signedAt: ${request.signedAt}`, `bodyHash: ${bodyHash}`,
  ].join("\n");
}

/**
 * Validate the envelope.
 *
 * `requireSignature: false` is for API-key callers: the server fills the nonce and
 * timestamp itself for them, so demanding a signed, clock-synced envelope would be
 * demanding proof of something the key already established. The signed path keeps
 * every check, because there the envelope IS the credential.
 */
export function validateAgentRequestEnvelope(
  request: SignedAgentRequest,
  now = Date.now(),
  opts: { requireSignature?: boolean } = {},
): string[] {
  const requireSignature = opts.requireSignature ?? true;
  const errors: string[] = [];
  if (!requireSignature) {
    if (request.version !== AGENT_API_VERSION) errors.push("unsupported version");
    if (!(AGENT_API_ACTIONS as readonly string[]).includes(request.action)) errors.push("unknown action");
    if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(request.agentId)) errors.push("invalid agentId");
    if (request.idempotencyKey && request.idempotencyKey.length > 128) errors.push("invalid idempotencyKey");
    return errors;
  }
  if (request.version !== AGENT_API_VERSION) errors.push("unsupported version");
  if (!(AGENT_API_ACTIONS as readonly string[]).includes(request.action)) errors.push("unknown action");
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(request.agentId)) errors.push("invalid agentId");
  if (!request.idempotencyKey || request.idempotencyKey.length > 128) errors.push("invalid idempotencyKey");
  if (!request.nonce || request.nonce.length > 128) errors.push("invalid nonce");
  if (!Number.isFinite(request.signedAt) || Math.abs(now - request.signedAt) > AGENT_REQUEST_MAX_SKEW_MS) {
    errors.push("signed timestamp outside allowed window");
  }
  if (!/^0x[0-9a-fA-F]+$/.test(request.signature)) errors.push("invalid signature encoding");
  return errors;
}
