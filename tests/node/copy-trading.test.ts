import assert from "node:assert/strict";
import test from "node:test";
import { copyPolicyHash, evaluateCopy, validateCopyPermission, worstCaseCopySpend, type CopyExecutionContext, type CopyPermission, type CopySignal } from "../../lib/copy-trading";

const USDC = "0x1111111111111111111111111111111111111111";
const MIMIR = "0x2222222222222222222222222222222222222222";
const NOW = 1_780_000_000_000;
function permission(overrides: Partial<CopyPermission> = {}): CopyPermission {
  const base = { permissionId: "perm-1", ownerWallet: "0x3333333333333333333333333333333333333333",
    executionAgentId: "agent-b", signalAgentId: "agent-a", maxPerPositionUsdc: 5,
    dailyCapUsdc: 10, weeklyCapUsdc: 30, totalOpenExposureUsdc: 20, maxRealizedLossAtomic: "15000000",
    allowedCategories: ["crypto"], allowedModes: ["pool"], minConfidenceBps: 7000,
    minPayoutBps: 12000, expiresAt: NOW + 60_000, depth: 1 as const, status: "active" as const,
    spendPermission: { token: USDC, spender: MIMIR, allowanceAtomic: 10_000_000n, periodSeconds: 86400 } };
  return { ...base, signedPolicyHash: copyPolicyHash(base), ...overrides };
}
function signal(overrides: Partial<CopySignal> = {}): CopySignal { return {
  sourcePositionId: "pos-a-1", signalAgentId: "agent-a", sourceDepth: 0, claimId: 7,
  category: "crypto", mode: "pool", confidenceBps: 8000, payoutBps: 15000,
  stakeUsdc: 3, deadline: NOW + 30_000, remainingSlots: 2, availableLiquidityUsdc: 10,
  requiredLiquidityUsdc: 3, sourceAttributionId: "attr-a-1", ...overrides }; }
function context(overrides: Partial<CopyExecutionContext> = {}): CopyExecutionContext { return {
  now: NOW, globalPaused: false, usage: { usedTodayUsdc: 0, usedThisWeekUsdc: 0, openExposureUsdc: 0, realizedLossAtomic: "0" },
  existingClaimIds: new Set(), ancestryAgentIds: ["agent-a"], configuredUsdc: USDC,
  configuredSpender: MIMIR, onchainAllowanceAtomic: 10_000_000n,
  simulation: { ok: true, blockNumber: 100n }, ...overrides }; }
const reason = (v: ReturnType<typeof evaluateCopy>) => "reason" in v ? v.reason : null;

test("follow is absent from permission: social state cannot spend", () => {
  assert.equal("followed" in permission(), false);
  assert.deepEqual(worstCaseCopySpend(permission()), { perPositionUsdc: 5, dailyUsdc: 10, weeklyUsdc: 30, totalOpenUsdc: 20 });
});
test("a fully admitted fresh signal executes", () => assert.deepEqual(evaluateCopy(permission(), signal(), context()), { allowed: true, stakeUsdc: 3 }));
test("revoke and global pause are immediate", () => {
  assert.equal(reason(evaluateCopy(permission({ status: "revoked" }), signal(), context())), "permission_revoked");
  assert.equal(reason(evaluateCopy(permission(), signal(), context({ globalPaused: true }))), "global_paused");
});
test("depth, self-copy and A-to-B-to-A cycles are blocked", () => {
  assert.equal(reason(evaluateCopy(permission(), signal({ sourceDepth: 1 }), context())), "copy_depth");
  assert.equal(reason(evaluateCopy(permission(), signal({ signalAgentId: "agent-b" }), context())), "self_copy");
  assert.equal(reason(evaluateCopy(permission(), signal(), context({ ancestryAgentIds: ["agent-b", "agent-a"] }))), "cycle");
});
test("duplicate, stale, full and exhausted markets skip before signing", () => {
  assert.equal(reason(evaluateCopy(permission(), signal(), context({ existingClaimIds: new Set([7]) }))), "duplicate_position");
  assert.equal(reason(evaluateCopy(permission(), signal({ deadline: NOW }), context())), "stale_signal");
  assert.equal(reason(evaluateCopy(permission(), signal({ remainingSlots: 0 }), context())), "market_full");
  assert.equal(reason(evaluateCopy(permission(), signal({ availableLiquidityUsdc: 2 }), context())), "liquidity_exhausted");
});
test("confidence, payout, position and rolling budgets are hard floors/caps", () => {
  assert.equal(reason(evaluateCopy(permission(), signal({ confidenceBps: 6999 }), context())), "confidence_below_floor");
  assert.equal(reason(evaluateCopy(permission(), signal({ payoutBps: 11999 }), context())), "payout_below_floor");
  assert.equal(reason(evaluateCopy(permission(), signal({ stakeUsdc: 6 }), context())), "position_cap");
  assert.equal(reason(evaluateCopy(permission(), signal(), context({ usage: { usedTodayUsdc: 8, usedThisWeekUsdc: 0, openExposureUsdc: 0, realizedLossAtomic: "0" } }))), "daily_cap");
});
test("the signed realized-loss limit reserves the full next principal", () => {
  assert.equal(reason(evaluateCopy(permission(), signal(), context({ usage: { usedTodayUsdc: 0, usedThisWeekUsdc: 0, openExposureUsdc: 0, realizedLossAtomic: "12000001" } }))), "loss_limit");
  assert.equal(evaluateCopy(permission(), signal(), context({ usage: { usedTodayUsdc: 0, usedThisWeekUsdc: 0, openExposureUsdc: 0, realizedLossAtomic: "12000000" } })).allowed, true);
});
test("malformed or unsafe copy policies are rejected before persistence", () => {
  const { signedPolicyHash: _, ...valid } = permission();
  assert.equal(validateCopyPermission(valid, NOW), null);
  assert.equal(validateCopyPermission({ ...valid, maxRealizedLossAtomic: "1e6" }, NOW), "invalid_budget");
  assert.equal(validateCopyPermission({ ...valid, ownerWallet: "0xnope" }, NOW), "invalid_address");
  assert.equal(validateCopyPermission({ ...valid, expiresAt: NOW }, NOW), "invalid_lifecycle");
});
test("on-chain token, spender and allowance are verified, then simulation must pass", () => {
  assert.equal(reason(evaluateCopy(permission(), signal(), context({ onchainAllowanceAtomic: 0n }))), "spend_permission_mismatch");
  assert.equal(reason(evaluateCopy(permission(), signal(), context({ simulation: { ok: false, blockNumber: 101n } }))), "simulation_failed");
});
