import assert from "node:assert/strict";
import test from "node:test";

import { USDC_ADDRESS } from "../../lib/usdc";
import {
  checkPermission, configuredSpender, currentPeriodStart, evaluateSpend,
  parseSpendPermissionGrant, permissionKey, type SpendPermissionRecord,
} from "../../lib/agents/spend-permissions";

const SPENDER = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const ACCOUNT = "0x2222222222222222222222222222222222222222" as `0x${string}`;
const DAY = 86_400;
const START = 1_800_000_000;

function permission(overrides: Partial<SpendPermissionRecord> = {}): SpendPermissionRecord {
  const fields = {
    account: ACCOUNT, spender: SPENDER, token: USDC_ADDRESS.toLowerCase() as `0x${string}`,
    allowanceAtomic: 50_000_000n, periodSeconds: 7 * DAY, startAt: START,
    endAt: START + 30 * DAY, salt: "0",
    ...overrides,
  };
  return {
    agentId: "forecaster", extraData: "0x", signature: "0xabc" as `0x${string}`,
    permissionJson: "{}", createdAt: START * 1000,
    ...overrides,
    ...fields,
    // Keyed from the merged fields, so an override actually changes the identity.
    permissionHash: permissionKey(fields),
  };
}

test("the same grant always keys to the same permission", () => {
  const a = permission();
  const b = permission();
  assert.equal(a.permissionHash, b.permissionHash);
  // A wider allowance is a different budget, not the same one re-signed.
  assert.notEqual(permission({ allowanceAtomic: 60_000_000n }).permissionHash, a.permissionHash);
});

test("periods advance in whole steps from the signed start", () => {
  const p = permission();
  assert.equal(currentPeriodStart(p, START), START);
  assert.equal(currentPeriodStart(p, START + DAY), START, "same period one day in");
  assert.equal(currentPeriodStart(p, START + 7 * DAY), START + 7 * DAY, "second period");
  assert.equal(currentPeriodStart(p, START + 15 * DAY), START + 14 * DAY);
  // Before the start there is no period to spend against.
  assert.equal(currentPeriodStart(p, START - 100), START);
});

test("a permission is refused before it starts, after it expires and once revoked", () => {
  const p = permission();
  assert.equal(checkPermission(p, START + DAY, SPENDER).ok, true);
  const early = checkPermission(p, START - 1, SPENDER);
  assert.equal(early.ok === false && early.reason, "not_started");
  const late = checkPermission(p, START + 30 * DAY, SPENDER);
  assert.equal(late.ok === false && late.reason, "expired");
  const revoked = checkPermission(permission({ revokedAt: START * 1000 }), START + DAY, SPENDER);
  assert.equal(revoked.ok === false && revoked.reason, "revoked");
});

test("a permission naming a different spender or token is refused", () => {
  const other = "0x3333333333333333333333333333333333333333" as `0x${string}`;
  const wrongSpender = checkPermission(permission(), START + DAY, other);
  assert.equal(wrongSpender.ok === false && wrongSpender.reason, "wrong_spender");
  // No configured spender at all must fail closed, not match anything.
  const noSpender = checkPermission(permission(), START + DAY, null);
  assert.equal(noSpender.ok === false && noSpender.reason, "wrong_spender");
  const wrongToken = checkPermission(permission({ token: other }), START + DAY, SPENDER);
  assert.equal(wrongToken.ok === false && wrongToken.reason, "wrong_token");
});

test("spend fits, then exhausts, then refreshes in the next period", () => {
  const p = permission();
  const now = START + DAY;
  const first = evaluateSpend({ permission: p, spentThisPeriodAtomic: 0n, amountAtomic: 2_000_000n, nowSeconds: now, spender: SPENDER });
  assert.equal(first.allowed, true);
  assert.equal(first.remainingAtomic, 48_000_000n);

  // 49 of 50 USDC already gone: a 2 USDC stake no longer fits.
  const tight = evaluateSpend({ permission: p, spentThisPeriodAtomic: 49_000_000n, amountAtomic: 2_000_000n, nowSeconds: now, spender: SPENDER });
  assert.equal(tight.allowed, false);
  assert.equal(tight.reason, "allowance_exhausted");
  assert.equal(tight.remainingAtomic, 1_000_000n, "a refusal still reports what is left");

  // The ledger is queried per period, so the next period starts from zero spent.
  const nextPeriod = evaluateSpend({ permission: p, spentThisPeriodAtomic: 0n, amountAtomic: 2_000_000n, nowSeconds: START + 8 * DAY, spender: SPENDER });
  assert.equal(nextPeriod.allowed, true);
  assert.equal(nextPeriod.periodStart, START + 7 * DAY);
});

test("a zero or negative amount is never allowed", () => {
  const p = permission();
  for (const amount of [0n, -1n]) {
    const decision = evaluateSpend({ permission: p, spentThisPeriodAtomic: 0n, amountAtomic: amount, nowSeconds: START + DAY, spender: SPENDER });
    assert.equal(decision.allowed, false, `${amount} must not be allowed`);
  }
});

test("a grant is parsed only when every field is present and sane", () => {
  const good = {
    account: ACCOUNT, spender: SPENDER, token: USDC_ADDRESS,
    allowance: "50000000", period: String(7 * DAY),
    start: String(START), end: String(START + 30 * DAY), signature: "0xabcdef",
  };
  const parsed = parseSpendPermissionGrant({ agentId: "forecaster", grant: good, spender: SPENDER, now: START * 1000 });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok && parsed.record.allowanceAtomic, 50_000_000n);

  // Each of these must refuse rather than default to something nobody agreed to.
  const cases: Array<[string, Record<string, unknown>]> = [
    ["no signature", { ...good, signature: undefined }],
    ["zero allowance", { ...good, allowance: "0" }],
    ["zero period", { ...good, period: "0" }],
    ["end before start", { ...good, end: String(START - 1) }],
    ["wrong token", { ...good, token: "0x3333333333333333333333333333333333333333" }],
    ["bad account", { ...good, account: "nope" }],
  ];
  for (const [label, grant] of cases) {
    const result = parseSpendPermissionGrant({ agentId: "forecaster", grant, spender: SPENDER, now: START * 1000 });
    assert.equal(result.ok, false, `${label} must be refused`);
  }
});

test("a grant for another deployment's spender is refused", () => {
  const grant = {
    account: ACCOUNT, spender: "0x9999999999999999999999999999999999999999",
    token: USDC_ADDRESS, allowance: "1000000", period: String(DAY),
    start: String(START), end: String(START + DAY * 2), signature: "0xabc",
  };
  const result = parseSpendPermissionGrant({ agentId: "forecaster", grant, spender: SPENDER, now: START * 1000 });
  assert.equal(result.ok, false);
});

test("an unset spender env reads as no spender rather than as a wildcard", () => {
  assert.equal(configuredSpender({}), null);
  assert.equal(configuredSpender({ SPEND_PERMISSION_SPENDER: "not-an-address" }), null);
  // Checksummed addresses are what wallets and block explorers hand out; the
  // comparison downstream is lowercase, so normalise on the way in.
  assert.equal(
    configuredSpender({ SPEND_PERMISSION_SPENDER: "0x7c3f6B6CDd57C735E393282b25291D8723D77044" }),
    "0x7c3f6b6cdd57c735e393282b25291d8723d77044",
  );
  assert.equal(configuredSpender({ SPEND_PERMISSION_SPENDER: `  ${SPENDER}  ` }), SPENDER);
});
