/**
 * Owner-signed spend permissions — the money bound on an API key.
 *
 * The key says who is calling; this says how much they may move and until when. The
 * owner signs it once in their own wallet, so Mimir never holds a key that can reach
 * their funds, and revoking is theirs to do at any time.
 *
 * Two independent ceilings apply to every funded action and both must pass:
 *
 *   permission  what the owner signed on chain terms — allowance per rolling
 *               period, with a start and an expiry. Authoritative.
 *   agent limit what the platform caps regardless of what the owner signed
 *               (per position, per day, open exposure). A generous permission
 *               cannot raise these.
 *
 * Period accounting is deterministic: allowance refreshes every `periodSeconds` from
 * `start`, it does not roll over. Spend is recorded in our own ledger so a refusal
 * costs no chain round-trip, and the chain stays the final authority on what
 * actually moved.
 */

import { keccak256, toBytes } from "viem";

import { USDC_ADDRESS } from "@/lib/usdc";

export interface SpendPermissionRecord {
  /** Local canonical key, not the on-chain permission hash. */
  permissionHash: string;
  agentId: string;
  /** The standard wallet the allowance is drawn from. */
  account: `0x${string}`;
  /** Who may draw it — Mimir's configured spender. */
  spender: `0x${string}`;
  token: `0x${string}`;
  allowanceAtomic: bigint;
  periodSeconds: number;
  /** Unix seconds. */
  startAt: number;
  endAt: number;
  salt: string;
  extraData: string;
  signature: `0x${string}`;
  /** Verbatim permission object as signed, for prepareSpendCallData. */
  permissionJson: string;
  createdAt: number;
  revokedAt?: number;
  revokedReason?: string;
}

export type PermissionRejection =
  | "wrong_token"
  | "wrong_spender"
  | "not_started"
  | "expired"
  | "revoked"
  | "zero_allowance"
  | "bad_period"
  | "allowance_exhausted";

/** Mimir's spender address. Unset means funded actions cannot be delegated at all. */
export function configuredSpender(env: Record<string, string | undefined> = process.env): `0x${string}` | null {
  const raw = env.SPEND_PERMISSION_SPENDER?.trim() ?? env.AGENT_SPENDER_ADDRESS?.trim();
  return raw && /^0x[0-9a-fA-F]{40}$/.test(raw) ? (raw.toLowerCase() as `0x${string}`) : null;
}

/**
 * Stable identity for a permission, so re-submitting the same grant updates the row
 * instead of creating a second budget for the same money.
 */
export function permissionKey(input: {
  account: string; spender: string; token: string; allowanceAtomic: bigint;
  periodSeconds: number; startAt: number; endAt: number; salt: string;
}): string {
  return keccak256(toBytes([
    input.account.toLowerCase(), input.spender.toLowerCase(), input.token.toLowerCase(),
    input.allowanceAtomic.toString(), String(input.periodSeconds),
    String(input.startAt), String(input.endAt), input.salt,
  ].join("|")));
}

/**
 * Start of the period a moment falls in. Before `start` there is no period yet, so
 * the caller must treat that as not-yet-active rather than as period zero.
 */
export function currentPeriodStart(
  permission: Pick<SpendPermissionRecord, "startAt" | "periodSeconds">,
  nowSeconds: number,
): number {
  if (nowSeconds < permission.startAt) return permission.startAt;
  const elapsed = nowSeconds - permission.startAt;
  return permission.startAt + Math.floor(elapsed / permission.periodSeconds) * permission.periodSeconds;
}

/** Static validity of the grant itself, independent of how much has been spent. */
export function checkPermission(
  permission: SpendPermissionRecord,
  nowSeconds: number,
  spender: `0x${string}` | null,
): { ok: true } | { ok: false; reason: PermissionRejection } {
  if (permission.revokedAt) return { ok: false, reason: "revoked" };
  if (permission.token.toLowerCase() !== USDC_ADDRESS.toLowerCase()) return { ok: false, reason: "wrong_token" };
  if (!spender || permission.spender.toLowerCase() !== spender.toLowerCase()) {
    return { ok: false, reason: "wrong_spender" };
  }
  if (permission.allowanceAtomic <= 0n) return { ok: false, reason: "zero_allowance" };
  if (!Number.isInteger(permission.periodSeconds) || permission.periodSeconds <= 0) {
    return { ok: false, reason: "bad_period" };
  }
  if (nowSeconds < permission.startAt) return { ok: false, reason: "not_started" };
  if (nowSeconds >= permission.endAt) return { ok: false, reason: "expired" };
  return { ok: true };
}

export interface SpendDecision {
  allowed: boolean;
  reason?: PermissionRejection;
  /** Left in the current period after this spend would land. */
  remainingAtomic: bigint;
  periodStart: number;
  periodEndsAt: number;
}

/**
 * Would this amount fit? Answers with the remaining allowance either way, because
 * "no" without a number is an agent that cannot decide whether to wait or to stop.
 */
export function evaluateSpend(args: {
  permission: SpendPermissionRecord;
  spentThisPeriodAtomic: bigint;
  amountAtomic: bigint;
  nowSeconds: number;
  spender: `0x${string}` | null;
}): SpendDecision {
  const { permission, spentThisPeriodAtomic, amountAtomic, nowSeconds, spender } = args;
  const periodStart = currentPeriodStart(permission, nowSeconds);
  const periodEndsAt = Math.min(periodStart + permission.periodSeconds, permission.endAt);
  const remainingBefore = permission.allowanceAtomic > spentThisPeriodAtomic
    ? permission.allowanceAtomic - spentThisPeriodAtomic
    : 0n;

  const valid = checkPermission(permission, nowSeconds, spender);
  if (!valid.ok) {
    return { allowed: false, reason: valid.reason, remainingAtomic: remainingBefore, periodStart, periodEndsAt };
  }
  if (amountAtomic <= 0n || amountAtomic > remainingBefore) {
    return { allowed: false, reason: "allowance_exhausted", remainingAtomic: remainingBefore, periodStart, periodEndsAt };
  }
  return { allowed: true, remainingAtomic: remainingBefore - amountAtomic, periodStart, periodEndsAt };
}

/** Shape accepted from the browser after the owner signs, before we trust any of it. */
export interface SpendPermissionGrant {
  account?: unknown;
  spender?: unknown;
  token?: unknown;
  allowance?: unknown;
  period?: unknown;
  start?: unknown;
  end?: unknown;
  salt?: unknown;
  extraData?: unknown;
  signature?: unknown;
  permission?: unknown;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function asAddress(value: unknown): `0x${string}` | null {
  return typeof value === "string" && ADDRESS.test(value) ? (value.toLowerCase() as `0x${string}`) : null;
}

function asBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.floor(value));
  if (typeof value === "string" && /^[0-9]+$/.test(value.trim())) return BigInt(value.trim());
  return null;
}

function asSeconds(value: unknown): number | null {
  const n = asBigInt(value);
  if (n === null) return null;
  const num = Number(n);
  return Number.isFinite(num) && num >= 0 ? Math.floor(num) : null;
}

/**
 * Parse and validate a grant into a record.
 *
 * Rejects on any field it cannot read rather than defaulting: a silently defaulted
 * expiry or allowance is a budget nobody agreed to.
 */
export function parseSpendPermissionGrant(args: {
  agentId: string;
  grant: SpendPermissionGrant;
  spender: `0x${string}` | null;
  now: number;
}): { ok: true; record: SpendPermissionRecord } | { ok: false; error: string } {
  const { agentId, grant, spender, now } = args;
  const account = asAddress(grant.account);
  if (!account) return { ok: false, error: "account must be an address" };
  const grantSpender = asAddress(grant.spender);
  if (!grantSpender) return { ok: false, error: "spender must be an address" };
  if (!spender) return { ok: false, error: "server has no configured spend permission spender" };
  if (grantSpender !== spender) return { ok: false, error: "spender does not match this deployment" };
  const token = asAddress(grant.token) ?? USDC_ADDRESS.toLowerCase() as `0x${string}`;
  if (token !== USDC_ADDRESS.toLowerCase()) return { ok: false, error: "only USDC permissions are accepted" };

  const allowanceAtomic = asBigInt(grant.allowance);
  if (allowanceAtomic === null || allowanceAtomic <= 0n) return { ok: false, error: "allowance must be a positive atomic amount" };
  const periodSeconds = asSeconds(grant.period);
  if (!periodSeconds) return { ok: false, error: "period must be positive seconds" };
  const startAt = asSeconds(grant.start);
  const endAt = asSeconds(grant.end);
  if (startAt === null || endAt === null) return { ok: false, error: "start and end must be unix seconds" };
  if (endAt <= startAt) return { ok: false, error: "end must follow start" };
  if (endAt * 1000 <= now) return { ok: false, error: "permission has already expired" };

  const signature = typeof grant.signature === "string" && /^0x[0-9a-fA-F]+$/.test(grant.signature)
    ? (grant.signature as `0x${string}`) : null;
  if (!signature) return { ok: false, error: "owner signature is required" };

  const salt = asBigInt(grant.salt)?.toString() ?? "0";
  const extraData = typeof grant.extraData === "string" && grant.extraData.startsWith("0x") ? grant.extraData : "0x";

  return {
    ok: true,
    record: {
      permissionHash: permissionKey({ account, spender: grantSpender, token, allowanceAtomic, periodSeconds, startAt, endAt, salt }),
      agentId, account, spender: grantSpender, token, allowanceAtomic, periodSeconds,
      startAt, endAt, salt, extraData, signature,
      // Stored verbatim: prepareSpendCallData must be handed the object the owner
      // actually signed, not one we rebuilt from parsed parts.
      permissionJson: JSON.stringify(grant.permission ?? grant),
      createdAt: now,
    },
  };
}
