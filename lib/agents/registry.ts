/**
 * Agent registry — the identity and permission model behind Bring Your Own Agent.
 *
 * The invariant that shapes everything: **Mimir never holds an external agent's
 * private key.** An agent proves who it is by signing a challenge with its own
 * wallet, and it signs its own transactions. Mimir verifies signatures and
 * enforces limits; it does not custody keys.
 *
 * Owner and operator are separated on purpose:
 *   owner    receives fees, and is the only party that can rotate or revoke
 *   operator the hot key that actually signs day to day
 * A compromised operator is then a revocation, not a loss of the agent — and the
 * revenue stream cannot be stolen by whoever grabs the hot key.
 *
 * Reputation never grants financial authority. Capability plus an explicit owner
 * permission is the only path to spending money, so a well-behaved agent cannot
 * accumulate its way into permissions nobody granted.
 */

import { keccak256, toBytes } from "viem";
import { parseUsdcAtomic } from "@/lib/usdc";

export const REGISTRY_SCHEMA_VERSION = 1;

/**
 * Capabilities are granted individually. An agent that may publish reasoning is
 * not thereby allowed to stake, and one that may propose markets is not allowed
 * to create them.
 */
export const AGENT_CAPABILITIES = [
  "market_creator",
  "council_juror",
  "researcher",
  "copy_source",
  "x402_seller",
] as const;
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

export function isAgentCapability(value: string): value is AgentCapability {
  return (AGENT_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Escalating authority. Each level is a superset of the one below, and every
 * level above 0 requires an explicit owner grant — never reputation alone.
 */
export const AUTHORITY_LEVELS = {
  /** Read markets and context. No writes of any kind. */
  READ_ONLY: 0,
  /** Propose a market; Mimir publishes it only after moderation/preflight. */
  PROPOSE: 1,
  /** Create markets from the agent's OWN wallet, within limits. */
  CREATE: 2,
  /** Vote and stake. */
  STAKE: 3,
  /** Be followed as a copy source, and sell over x402. */
  MONETISE: 4,
} as const;
export type AuthorityLevel = (typeof AUTHORITY_LEVELS)[keyof typeof AUTHORITY_LEVELS];

export type AgentStatus = "pending" | "active" | "paused" | "revoked";

/** Hard ceilings the platform enforces; the agent cannot raise its own. */
export interface AgentLimits {
  /** Requests per rolling hour against Mimir's agent API. */
  maxRequestsPerHour: number;
  /** Markets this agent may have open at once. */
  maxActiveMarkets: number;
  /** USDC this agent may put at risk per rolling day. */
  maxDailyExposureUsdc: number;
  /** USDC per single position. */
  maxPositionUsdc: number;
  /** Authoritative 6-decimal limits; decimal strings remain JSON/signature safe. */
  maxDailyExposureAtomic: string;
  maxPositionAtomic: string;
  /** Categories the agent may act in. Empty means all. */
  allowedCategories: string[];
  /** Settlement modes the agent may use. Empty means all. */
  allowedSettlementModes: string[];
}

export interface AgentRecord {
  schemaVersion: number;
  agentId: string;
  /** Receives owner fees; the only party that may rotate or revoke. */
  ownerWallet: string;
  /** The hot key that signs day to day. Rotatable by the owner. */
  operatorWallet: string;
  /** Where owner fees are paid. Defaults to the owner wallet. */
  payoutWallet: string;
  displayName: string;
  description: string;
  /** Off-chain metadata document, plus its hash so edits are detectable. */
  metadataUri?: string;
  metadataHash?: string;
  capabilities: AgentCapability[];
  authorityLevel: AuthorityLevel;
  limits: AgentLimits;
  status: AgentStatus;
  /** Observational only. Never a source of authority — see module header. */
  reputationBps: number;
  createdAt: number;
  updatedAt: number;
  revokedAt?: number;
  revokedReason?: string;
}

/** Conservative defaults: a new agent can look, and nothing else. */
export function defaultLimits(): AgentLimits {
  return {
    maxRequestsPerHour: 120,
    maxActiveMarkets: 3,
    maxDailyExposureUsdc: 20,
    maxPositionUsdc: 5,
    maxDailyExposureAtomic: "20000000",
    maxPositionAtomic: "5000000",
    allowedCategories: [],
    allowedSettlementModes: [],
  };
}

// ── Registration challenge ────────────────────────────────────────────────────

/**
 * The message an agent signs to prove it controls a wallet.
 *
 * Domain-bound (chain id and the literal "Mimir"), nonce'd and expiring, so a
 * signature cannot be replayed against another site, another chain, or a second
 * registration. Human-readable because the signer may be a hardware wallet whose
 * owner should be able to read what they are approving.
 */
export interface RegistrationChallenge {
  agentId: string;
  wallet: string;
  nonce: string;
  chainId: number;
  issuedAt: number;
  expiresAt: number;
  /** "owner" proves fee ownership; "operator" proves the signing key. */
  role: "owner" | "operator";
}

export const CHALLENGE_TTL_MS = 10 * 60 * 1000;

export function buildChallengeMessage(challenge: RegistrationChallenge): string {
  return [
    "Mimir agent registration",
    `agent: ${challenge.agentId}`,
    `role: ${challenge.role}`,
    `wallet: ${challenge.wallet.toLowerCase()}`,
    `chainId: ${challenge.chainId}`,
    `nonce: ${challenge.nonce}`,
    `issuedAt: ${new Date(challenge.issuedAt).toISOString()}`,
    `expiresAt: ${new Date(challenge.expiresAt).toISOString()}`,
    "",
    "Signing proves you control this wallet. It does not move funds and does not",
    "grant Mimir permission to spend on your behalf.",
  ].join("\n");
}

export type ChallengeRejection =
  | "expired"
  | "not_yet_valid"
  | "wrong_chain"
  | "wrong_wallet"
  | "nonce_reused"
  | "malformed";

export interface ChallengeVerdict {
  ok: boolean;
  reason?: ChallengeRejection;
}

/**
 * Validate the challenge envelope. Signature recovery is the caller's job (it
 * needs viem and possibly EIP-1271); this is the replay and freshness policy,
 * kept pure so it is exhaustively testable.
 */
export function verifyChallenge(args: {
  challenge: RegistrationChallenge;
  /** Wallet the recovered signature actually belongs to. */
  recoveredWallet: string;
  expectedChainId: number;
  /** Nonces already consumed. */
  usedNonces: ReadonlySet<string>;
  now?: number;
}): ChallengeVerdict {
  const { challenge, recoveredWallet, expectedChainId, usedNonces } = args;
  const now = args.now ?? Date.now();

  if (!challenge.nonce || !challenge.wallet || !challenge.agentId) {
    return { ok: false, reason: "malformed" };
  }
  if (usedNonces.has(challenge.nonce)) return { ok: false, reason: "nonce_reused" };
  if (challenge.chainId !== expectedChainId) return { ok: false, reason: "wrong_chain" };
  if (now > challenge.expiresAt) return { ok: false, reason: "expired" };
  // A challenge issued in the future is a clock-skew or forgery signal.
  if (now + 60_000 < challenge.issuedAt) return { ok: false, reason: "not_yet_valid" };
  if (challenge.wallet.toLowerCase() !== recoveredWallet.toLowerCase()) {
    return { ok: false, reason: "wrong_wallet" };
  }
  return { ok: true };
}

// ── Capability and authority checks ───────────────────────────────────────────

/** The minimum authority level each capability needs to be exercisable. */
const CAPABILITY_MIN_AUTHORITY: Record<AgentCapability, AuthorityLevel> = {
  researcher: AUTHORITY_LEVELS.READ_ONLY,
  market_creator: AUTHORITY_LEVELS.PROPOSE,
  council_juror: AUTHORITY_LEVELS.STAKE,
  copy_source: AUTHORITY_LEVELS.MONETISE,
  x402_seller: AUTHORITY_LEVELS.MONETISE,
};

export type ActionRejection =
  | "platform_paused"
  | "revoked"
  | "paused"
  | "pending"
  | "missing_capability"
  | "insufficient_authority"
  | "category_not_allowed"
  | "mode_not_allowed"
  | "position_too_large"
  | "daily_exposure_exceeded"
  | "too_many_active_markets"
  | "rate_limit_exceeded";

export interface ActionVerdict {
  allowed: boolean;
  reason?: ActionRejection;
  detail?: string;
}

export interface ActionRequest {
  capability: AgentCapability;
  category?: string;
  settlementMode?: string;
  /** USDC this action puts at risk. */
  positionUsdc?: number;
  positionAtomic?: string;
  /** USDC already at risk today. */
  exposureTodayUsdc?: number;
  exposureTodayAtomic?: string;
  activeMarkets?: number;
  /** Requests already accepted in the current rolling hour. */
  requestsThisHour?: number;
  /** Emergency platform kill-switch, checked before agent-local state. */
  platformPaused?: boolean;
  /** market_creator at level 1 may propose, but cannot fund/create. */
  proposalOnly?: boolean;
}

/**
 * The single gate every funded agent action passes.
 *
 * Order matters: status first (a revoked agent is refused before anything else),
 * then the grant, then the limits. A revoked agent must never receive a
 * "position too large" message — that would imply a smaller one would work.
 */
export function authorizeAction(agent: AgentRecord, request: ActionRequest): ActionVerdict {
  if (request.platformPaused) {
    return { allowed: false, reason: "platform_paused", detail: "funded agent actions are paused" };
  }
  if (agent.status === "revoked") {
    return { allowed: false, reason: "revoked", detail: agent.revokedReason ?? "agent revoked" };
  }
  if (agent.status === "paused") return { allowed: false, reason: "paused", detail: "agent paused" };
  if (agent.status === "pending") {
    return { allowed: false, reason: "pending", detail: "registration not yet approved" };
  }

  if (!agent.capabilities.includes(request.capability)) {
    return {
      allowed: false,
      reason: "missing_capability",
      detail: `'${request.capability}' was never granted`,
    };
  }
  const required = request.capability === "market_creator" && !request.proposalOnly
    ? AUTHORITY_LEVELS.CREATE
    : CAPABILITY_MIN_AUTHORITY[request.capability];
  if (agent.authorityLevel < required) {
    return {
      allowed: false,
      reason: "insufficient_authority",
      detail: `'${request.capability}' needs level ${required}, agent is level ${agent.authorityLevel}`,
    };
  }

  const { limits } = agent;
  if ((request.requestsThisHour ?? 0) >= limits.maxRequestsPerHour) {
    return {
      allowed: false,
      reason: "rate_limit_exceeded",
      detail: `${request.requestsThisHour} of ${limits.maxRequestsPerHour} requests used`,
    };
  }
  if (
    request.category &&
    limits.allowedCategories.length > 0 &&
    !limits.allowedCategories.includes(request.category)
  ) {
    return { allowed: false, reason: "category_not_allowed", detail: request.category };
  }
  if (
    request.settlementMode &&
    limits.allowedSettlementModes.length > 0 &&
    !limits.allowedSettlementModes.includes(request.settlementMode)
  ) {
    return { allowed: false, reason: "mode_not_allowed", detail: request.settlementMode };
  }

  if (request.positionUsdc !== undefined || request.positionAtomic !== undefined) {
    const position = request.positionAtomic !== undefined ? BigInt(request.positionAtomic) : parseUsdcAtomic(request.positionUsdc!);
    const maxPosition = BigInt(limits.maxPositionAtomic ?? parseUsdcAtomic(limits.maxPositionUsdc));
    const maxDaily = BigInt(limits.maxDailyExposureAtomic ?? parseUsdcAtomic(limits.maxDailyExposureUsdc));
    if (position > maxPosition) {
      return {
        allowed: false,
        reason: "position_too_large",
        detail: `${position} atomic exceeds the ${maxPosition} atomic per-position limit`,
      };
    }
    const existing = request.exposureTodayAtomic !== undefined ? BigInt(request.exposureTodayAtomic) : parseUsdcAtomic(request.exposureTodayUsdc ?? 0);
    const exposure = existing + position;
    if (exposure > maxDaily) {
      return {
        allowed: false,
        reason: "daily_exposure_exceeded",
        detail: `${exposure} atomic would exceed the ${maxDaily} atomic daily limit`,
      };
    }
  }

  if (
    request.capability === "market_creator" &&
    request.activeMarkets !== undefined &&
    request.activeMarkets >= limits.maxActiveMarkets
  ) {
    return {
      allowed: false,
      reason: "too_many_active_markets",
      detail: `${request.activeMarkets} of ${limits.maxActiveMarkets} slots used`,
    };
  }

  return { allowed: true };
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/**
 * Only the owner may rotate the operator key. Rotation is how a compromised hot
 * key is recovered from, so letting the operator rotate itself would let an
 * attacker lock the owner out.
 */
export function rotateOperator(
  agent: AgentRecord,
  args: { requestedBy: string; newOperatorWallet: string; at?: number },
): { ok: true; agent: AgentRecord } | { ok: false; reason: "not_owner" | "revoked" | "same_wallet" } {
  if (agent.status === "revoked") return { ok: false, reason: "revoked" };
  if (args.requestedBy.toLowerCase() !== agent.ownerWallet.toLowerCase()) {
    return { ok: false, reason: "not_owner" };
  }
  if (args.newOperatorWallet.toLowerCase() === agent.operatorWallet.toLowerCase()) {
    return { ok: false, reason: "same_wallet" };
  }
  return {
    ok: true,
    agent: {
      ...agent,
      operatorWallet: args.newOperatorWallet.toLowerCase(),
      updatedAt: args.at ?? Date.now(),
    },
  };
}

/**
 * Revocation is terminal and immediate. Nothing re-enables a revoked agent —
 * re-admitting one is a fresh registration, so a revocation cannot be quietly
 * undone by an operator who still holds a key.
 */
export function revokeAgent(
  agent: AgentRecord,
  args: { requestedBy: string; reason: string; at?: number },
): { ok: true; agent: AgentRecord } | { ok: false; reason: "not_owner" } {
  if (args.requestedBy.toLowerCase() !== agent.ownerWallet.toLowerCase()) {
    return { ok: false, reason: "not_owner" };
  }
  const at = args.at ?? Date.now();
  return {
    ok: true,
    agent: {
      ...agent,
      status: "revoked",
      // Capabilities are cleared, not just gated: a stale in-memory copy that
      // only checks capabilities still refuses.
      capabilities: [],
      authorityLevel: AUTHORITY_LEVELS.READ_ONLY,
      revokedAt: at,
      revokedReason: args.reason,
      updatedAt: at,
    },
  };
}

/** Grant a capability. Owner only, and never above the agent's authority level. */
export function grantCapability(
  agent: AgentRecord,
  args: { requestedBy: string; capability: AgentCapability; at?: number },
):
  | { ok: true; agent: AgentRecord }
  | { ok: false; reason: "not_owner" | "revoked" | "insufficient_authority" } {
  if (agent.status === "revoked") return { ok: false, reason: "revoked" };
  if (args.requestedBy.toLowerCase() !== agent.ownerWallet.toLowerCase()) {
    return { ok: false, reason: "not_owner" };
  }
  if (agent.authorityLevel < CAPABILITY_MIN_AUTHORITY[args.capability]) {
    // Granting a capability the level cannot exercise would be a silent no-op
    // that reads, in the UI, like a working permission.
    return { ok: false, reason: "insufficient_authority" };
  }
  if (agent.capabilities.includes(args.capability)) return { ok: true, agent };
  return {
    ok: true,
    agent: {
      ...agent,
      capabilities: [...agent.capabilities, args.capability],
      updatedAt: args.at ?? Date.now(),
    },
  };
}

/** Metadata hash so an off-chain document cannot be swapped silently. */
export function metadataHash(document: string): `0x${string}` {
  return keccak256(toBytes(document));
}
