/** Copy trading policy and deterministic execution gate. */

import { isAddress, keccak256, toBytes } from "viem";
import { parseUsdcAtomic } from "@/lib/usdc";

export interface CopyPermission {
  permissionId: string;
  ownerWallet: string;
  executionAgentId: string;
  signalAgentId: string;
  maxPerPositionUsdc: number;
  dailyCapUsdc: number;
  weeklyCapUsdc: number;
  totalOpenExposureUsdc: number;
  /** Maximum realized loss plus the full principal at risk of the next copy. */
  maxRealizedLossAtomic: string;
  allowedCategories: string[];
  allowedModes: string[];
  minConfidenceBps: number;
  minPayoutBps: number;
  expiresAt: number;
  depth: 1;
  status: "active" | "revoked" | "paused";
  spendPermission: { token: string; spender: string; allowanceAtomic: bigint; periodSeconds: number };
  signedPolicyHash: string;
}

export interface CopyUsage {
  usedTodayUsdc: number;
  usedThisWeekUsdc: number;
  openExposureUsdc: number;
  realizedLossAtomic: string;
}

export interface CopySignal {
  sourcePositionId: string;
  signalAgentId: string;
  sourceDepth: number;
  claimId: number;
  category: string;
  mode: string;
  confidenceBps: number;
  payoutBps: number;
  stakeUsdc: number;
  deadline: number;
  remainingSlots: number;
  availableLiquidityUsdc: number;
  requiredLiquidityUsdc: number;
  sourceAttributionId: string;
}

export type CopySkipReason =
  | "global_paused" | "permission_revoked" | "permission_paused" | "permission_expired"
  | "self_copy" | "copy_depth" | "cycle" | "duplicate_position" | "stale_signal"
  | "market_full" | "liquidity_exhausted" | "category_blocked" | "mode_blocked"
  | "confidence_below_floor" | "payout_below_floor" | "position_cap"
  | "daily_cap" | "weekly_cap" | "open_exposure_cap" | "spend_permission_mismatch"
  | "loss_limit" | "simulation_failed";

export interface CopyExecutionContext {
  now: number;
  globalPaused: boolean;
  usage: CopyUsage;
  existingClaimIds: ReadonlySet<number>;
  ancestryAgentIds: readonly string[];
  configuredUsdc: string;
  configuredSpender: string;
  onchainAllowanceAtomic: bigint;
  simulation: { ok: boolean; blockNumber: bigint; reason?: string };
}

export function copyPolicyHash(input: Omit<CopyPermission, "signedPolicyHash">): `0x${string}` {
  return keccak256(toBytes(JSON.stringify(input, (_, value) => typeof value === "bigint" ? value.toString() : value)));
}

function parseAtomicString(value: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error("invalid atomic amount");
  return BigInt(value);
}

/** Validate the externally supplied, owner-signed policy before storing it. */
export function validateCopyPermission(input: Omit<CopyPermission, "signedPolicyHash">, now = Date.now()): string | null {
  if (!input.permissionId.trim() || input.permissionId.length > 128) return "invalid_permission_id";
  if (!isAddress(input.ownerWallet) || !isAddress(input.spendPermission.token) || !isAddress(input.spendPermission.spender)) return "invalid_address";
  if (!input.executionAgentId.trim() || !input.signalAgentId.trim() || input.executionAgentId === input.signalAgentId) return "invalid_agent_pair";
  try {
    const position = parseUsdcAtomic(input.maxPerPositionUsdc);
    const daily = parseUsdcAtomic(input.dailyCapUsdc);
    const weekly = parseUsdcAtomic(input.weeklyCapUsdc);
    const exposure = parseUsdcAtomic(input.totalOpenExposureUsdc);
    const loss = parseAtomicString(input.maxRealizedLossAtomic);
    if (position <= 0n || daily < position || weekly < daily || exposure < position || loss <= 0n) return "invalid_budget";
  } catch { return "invalid_budget"; }
  if (input.spendPermission.allowanceAtomic <= 0n || !Number.isSafeInteger(input.spendPermission.periodSeconds) || input.spendPermission.periodSeconds <= 0) return "invalid_spend_permission";
  if (input.depth !== 1 || input.status !== "active" || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now) return "invalid_lifecycle";
  if (!Number.isInteger(input.minConfidenceBps) || input.minConfidenceBps < 0 || input.minConfidenceBps > 10_000 ||
      !Number.isInteger(input.minPayoutBps) || input.minPayoutBps < 0) return "invalid_threshold";
  if (!Array.isArray(input.allowedCategories) || !Array.isArray(input.allowedModes) ||
      input.allowedCategories.length > 100 || input.allowedModes.length > 10) return "invalid_allowlist";
  return null;
}

export function worstCaseCopySpend(permission: CopyPermission): { perPositionUsdc: number; dailyUsdc: number; weeklyUsdc: number; totalOpenUsdc: number } {
  return { perPositionUsdc: permission.maxPerPositionUsdc, dailyUsdc: permission.dailyCapUsdc,
    weeklyUsdc: permission.weeklyCapUsdc, totalOpenUsdc: permission.totalOpenExposureUsdc };
}

export function evaluateCopy(permission: CopyPermission, signal: CopySignal, context: CopyExecutionContext):
  { allowed: true; stakeUsdc: number } | { allowed: false; reason: CopySkipReason } {
  if (context.globalPaused) return { allowed: false, reason: "global_paused" };
  if (permission.status === "revoked") return { allowed: false, reason: "permission_revoked" };
  if (permission.status === "paused") return { allowed: false, reason: "permission_paused" };
  if (context.now >= permission.expiresAt) return { allowed: false, reason: "permission_expired" };
  if (signal.signalAgentId === permission.executionAgentId) return { allowed: false, reason: "self_copy" };
  if (signal.sourceDepth >= permission.depth) return { allowed: false, reason: "copy_depth" };
  if (context.ancestryAgentIds.map((id) => id.toLowerCase()).includes(permission.executionAgentId.toLowerCase())) {
    return { allowed: false, reason: "cycle" };
  }
  if (context.existingClaimIds.has(signal.claimId)) return { allowed: false, reason: "duplicate_position" };
  if (signal.deadline <= context.now) return { allowed: false, reason: "stale_signal" };
  if (signal.remainingSlots <= 0) return { allowed: false, reason: "market_full" };
  if (parseUsdcAtomic(signal.requiredLiquidityUsdc) > parseUsdcAtomic(signal.availableLiquidityUsdc)) return { allowed: false, reason: "liquidity_exhausted" };
  if (permission.allowedCategories.length && !permission.allowedCategories.includes(signal.category)) return { allowed: false, reason: "category_blocked" };
  if (permission.allowedModes.length && !permission.allowedModes.includes(signal.mode)) return { allowed: false, reason: "mode_blocked" };
  if (signal.confidenceBps < permission.minConfidenceBps) return { allowed: false, reason: "confidence_below_floor" };
  if (signal.payoutBps < permission.minPayoutBps) return { allowed: false, reason: "payout_below_floor" };
  const stake = signal.stakeUsdc;
  const stakeAtomic = parseUsdcAtomic(stake);
  if (stakeAtomic <= 0n || stakeAtomic > parseUsdcAtomic(permission.maxPerPositionUsdc)) return { allowed: false, reason: "position_cap" };
  if (parseUsdcAtomic(context.usage.usedTodayUsdc) + stakeAtomic > parseUsdcAtomic(permission.dailyCapUsdc)) return { allowed: false, reason: "daily_cap" };
  if (parseUsdcAtomic(context.usage.usedThisWeekUsdc) + stakeAtomic > parseUsdcAtomic(permission.weeklyCapUsdc)) return { allowed: false, reason: "weekly_cap" };
  if (parseUsdcAtomic(context.usage.openExposureUsdc) + stakeAtomic > parseUsdcAtomic(permission.totalOpenExposureUsdc)) return { allowed: false, reason: "open_exposure_cap" };
  if (parseAtomicString(context.usage.realizedLossAtomic) + stakeAtomic > parseAtomicString(permission.maxRealizedLossAtomic)) return { allowed: false, reason: "loss_limit" };
  const spend = permission.spendPermission;
  const requiredAtomic = stakeAtomic;
  if (spend.token.toLowerCase() !== context.configuredUsdc.toLowerCase() ||
      spend.spender.toLowerCase() !== context.configuredSpender.toLowerCase() ||
      spend.allowanceAtomic < requiredAtomic || context.onchainAllowanceAtomic < requiredAtomic) {
    return { allowed: false, reason: "spend_permission_mismatch" };
  }
  if (!context.simulation.ok) return { allowed: false, reason: "simulation_failed" };
  return { allowed: true, stakeUsdc: stake };
}

export interface CopyAuditRecord {
  executionId: string;
  permissionId: string;
  sourcePositionId: string;
  signalAgentId: string;
  executionAgentId: string;
  sourceAttributionId: string;
  status: "executed" | "skipped" | "failed" | "expired";
  stakeAtomic: bigint;
  simulationBlock: bigint;
  txHash?: string;
  platformFeeAtomic: bigint;
  ownerFeeAtomic: bigint;
  skipReason?: CopySkipReason;
  createdAt: number;
}
