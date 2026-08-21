import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentDryRun } from "../../lib/agents/dry-run";

test("dry-run exposes policy, allowance, payout and both fee lines before signing", () => {
  const preview = buildAgentDryRun({ principalUsdc: 10, grossPayoutUsdc: 20,
    outcome: "creator_wins", allowanceAtomic: 10_000_000n, requiredAtomic: 10_000_000n,
    platformFeeBps: 300, agentOwnerFeeBps: 100,
    platformRecipient: "0x1111111111111111111111111111111111111111",
    ownerRecipient: "0x2222222222222222222222222222222222222222",
    policy: { allowed: true } });
  assert.equal(preview.allowed, true);
  assert.equal(preview.allowance.sufficient, true);
  assert.equal(preview.payout.platformFeeUsdc, 0.3);
  assert.equal(preview.payout.agentOwnerFeeUsdc, 0.1);
  assert.equal(preview.payout.totalReturnUsdc, 19.6);
});

test("dry-run refuses insufficient allowance even when registry policy allows", () => {
  const preview = buildAgentDryRun({ principalUsdc: 2, grossPayoutUsdc: 4,
    outcome: "challengers_win", allowanceAtomic: 0n, requiredAtomic: 2_000_000n,
    platformFeeBps: 0, agentOwnerFeeBps: 0, platformRecipient: "", ownerRecipient: "",
    policy: { allowed: true } });
  assert.equal(preview.allowed, false);
  assert.equal(preview.allowance.sufficient, false);
});
