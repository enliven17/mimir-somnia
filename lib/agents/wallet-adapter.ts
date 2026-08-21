/** Vendor-neutral wallet boundary for BYOA funded actions. */

import { USDC_ADDRESS } from "@/lib/usdc";

export type AgentWalletKind = "eoa" | "eip1271" | "delegated_account" | "managed_agent";

export interface AgentWalletAdapter {
  readonly kind: AgentWalletKind;
  readonly address: `0x${string}`;
  /** EOA and smart-wallet signatures are verified through the same caller API. */
  verifySignature(args: { message: string; signature: `0x${string}` }): Promise<boolean>;
  simulate(call: AgentWalletCall): Promise<{ ok: boolean; reason?: string }>;
  send(call: AgentWalletCall): Promise<`0x${string}`>;
}

export interface AgentWalletCall {
  target: `0x${string}`;
  data: `0x${string}`;
  value?: bigint;
  /** Atomic USDC newly exposed by the call. */
  exposureAtomic: bigint;
  sponsorGas?: boolean;
}

export interface WalletBudgetPolicy {
  maxPerCallAtomic: bigint;
  maxPerSessionAtomic: bigint;
  maxPerDayAtomic: bigint;
  maxTotalOpenExposureAtomic: bigint;
  allowedTargets: readonly `0x${string}`[];
  paused: boolean;
}

export interface WalletBudgetUsage {
  sessionAtomic: bigint;
  dayAtomic: bigint;
  totalOpenExposureAtomic: bigint;
}

export type WalletBudgetRejection =
  | "paused"
  | "target_not_allowed"
  | "native_value_forbidden"
  | "per_call_exceeded"
  | "session_exceeded"
  | "day_exceeded"
  | "total_exposure_exceeded"
  | "gas_sponsorship_not_allowed";

export function authorizeWalletCall(args: {
  call: AgentWalletCall;
  policy: WalletBudgetPolicy;
  usage: WalletBudgetUsage;
}): { allowed: true } | { allowed: false; reason: WalletBudgetRejection } {
  const { call, policy, usage } = args;
  if (policy.paused) return { allowed: false, reason: "paused" };
  const allowed = policy.allowedTargets.some((target) => target.toLowerCase() === call.target.toLowerCase());
  if (call.sponsorGas && !allowed) return { allowed: false, reason: "gas_sponsorship_not_allowed" };
  if (!allowed) return { allowed: false, reason: "target_not_allowed" };
  // Stakes are configured USDC only. Native value is gas, never a funded action.
  if ((call.value ?? 0n) !== 0n) return { allowed: false, reason: "native_value_forbidden" };
  if (call.exposureAtomic > policy.maxPerCallAtomic) return { allowed: false, reason: "per_call_exceeded" };
  if (usage.sessionAtomic + call.exposureAtomic > policy.maxPerSessionAtomic) {
    return { allowed: false, reason: "session_exceeded" };
  }
  if (usage.dayAtomic + call.exposureAtomic > policy.maxPerDayAtomic) {
    return { allowed: false, reason: "day_exceeded" };
  }
  if (usage.totalOpenExposureAtomic + call.exposureAtomic > policy.maxTotalOpenExposureAtomic) {
    return { allowed: false, reason: "total_exposure_exceeded" };
  }
  // Sponsorship never broadens the target allowlist. Keeping this explicit makes
  // a future paymaster adapter prove the call is already admitted.
  return { allowed: true };
}

export interface WalletSpendPermissionDraft {
  account: `0x${string}`;
  spender: `0x${string}`;
  token: `0x${string}`;
  allowanceAtomic: bigint;
  periodSeconds: number;
  start: number;
  end: number;
}

/** Build the constrained shape passed to standard wallet Spend Permissions. */
export function walletSpendPermission(args: Omit<WalletSpendPermissionDraft, "token">): WalletSpendPermissionDraft {
  if (args.allowanceAtomic <= 0n) throw new Error("allowance must be positive");
  if (!Number.isInteger(args.periodSeconds) || args.periodSeconds <= 0) throw new Error("period must be positive");
  if (args.end <= args.start) throw new Error("permission expiry must follow start");
  return { ...args, token: USDC_ADDRESS };
}

/** CDP/AgentKit implementations and legacy EOAs plug into this same interface. */
export function assertWalletAdapter(adapter: AgentWalletAdapter): AgentWalletAdapter {
  if (!/^0x[0-9a-fA-F]{40}$/.test(adapter.address)) throw new Error("invalid adapter address");
  return adapter;
}
