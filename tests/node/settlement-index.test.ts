import assert from "node:assert/strict";
import test from "node:test";

import { grossVolume, splitFees } from "../../lib/server/settlement-index";

test("fees split by their agent-owner flag", () => {
  const { platformAtomic, agentOwnerAtomic } = splitFees([
    { amount: 30_000n, isAgentOwnerFee: false },
    { amount: 20_000n, isAgentOwnerFee: true },
    { amount: 10_000n, isAgentOwnerFee: false },
  ]);
  assert.equal(platformAtomic, 40_000n);
  assert.equal(agentOwnerAtomic, 20_000n);
});

test("a market with no accruals splits to zero rather than throwing", () => {
  assert.deepEqual(splitFees([]), { platformAtomic: 0n, agentOwnerAtomic: 0n });
});

test("gross volume accounts for every atom the contract moved", () => {
  // 4 USDC staked, settled as 3.94 payout + 0.05 fees + 0.01 dust: nothing may be
  // lost between the stake and the three buckets, or the dashboard under-reports
  // volume against the chain.
  assert.equal(grossVolume(3_940_000n, 50_000n, 10_000n), 4_000_000n);
});
