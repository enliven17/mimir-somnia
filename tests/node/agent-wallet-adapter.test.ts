import assert from "node:assert/strict";
import test from "node:test";
import { USDC_ADDRESS } from "../../lib/usdc";
import { authorizeWalletCall, walletSpendPermission, type WalletBudgetPolicy } from "../../lib/agents/wallet-adapter";

const MIMIR = "0x1111111111111111111111111111111111111111" as const;
const ACCOUNT = "0x2222222222222222222222222222222222222222" as const;
const call = (exposureAtomic = 1n) => ({ target: MIMIR, data: "0x" as const, exposureAtomic });
const policy = (overrides: Partial<WalletBudgetPolicy> = {}): WalletBudgetPolicy => ({
  maxPerCallAtomic: 5n,
  maxPerSessionAtomic: 10n,
  maxPerDayAtomic: 20n,
  maxTotalOpenExposureAtomic: 30n,
  allowedTargets: [MIMIR],
  paused: false,
  ...overrides,
});
const usage = { sessionAtomic: 0n, dayAtomic: 0n, totalOpenExposureAtomic: 0n };
const reason = (result: ReturnType<typeof authorizeWalletCall>) => "reason" in result ? result.reason : null;

test("wallet budget enforces call, session, day and total exposure independently", () => {
  assert.equal(reason(authorizeWalletCall({ call: call(6n), policy: policy(), usage })), "per_call_exceeded");
  assert.equal(reason(authorizeWalletCall({ call: call(3n), policy: policy(), usage: { ...usage, sessionAtomic: 8n } })), "session_exceeded");
  assert.equal(reason(authorizeWalletCall({ call: call(3n), policy: policy(), usage: { ...usage, dayAtomic: 19n } })), "day_exceeded");
  assert.equal(reason(authorizeWalletCall({ call: call(3n), policy: policy(), usage: { ...usage, totalOpenExposureAtomic: 29n } })), "total_exposure_exceeded");
});

test("pause, target allowlist and native-value prohibition cannot be bypassed", () => {
  assert.equal(reason(authorizeWalletCall({ call: call(), policy: policy({ paused: true }), usage })), "paused");
  assert.equal(reason(authorizeWalletCall({ call: { ...call(), target: ACCOUNT }, policy: policy(), usage })), "target_not_allowed");
  assert.equal(reason(authorizeWalletCall({ call: { ...call(), value: 1n }, policy: policy(), usage })), "native_value_forbidden");
});

test("Wallet Spend Permission is always configured USDC with bounded time and allowance", () => {
  const permission = walletSpendPermission({ account: ACCOUNT, spender: MIMIR, allowanceAtomic: 5_000_000n, periodSeconds: 86_400, start: 100, end: 200 });
  assert.equal(permission.token.toLowerCase(), USDC_ADDRESS.toLowerCase());
  assert.throws(() => walletSpendPermission({ ...permission, allowanceAtomic: 0n }), /allowance/);
  assert.throws(() => walletSpendPermission({ ...permission, end: 99 }), /expiry/);
});
