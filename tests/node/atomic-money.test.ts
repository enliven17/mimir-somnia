import assert from "node:assert/strict";
import test from "node:test";
import { authorizeAction, defaultLimits, type AgentRecord } from "../../lib/agents/registry";
import { formatAtomicUsdc, parseUsdcAtomic } from "../../lib/usdc";

test("USDC parsing and rendering is exact at six decimals", () => {
  assert.equal(parseUsdcAtomic("9007199254740993.123456"), 9007199254740993123456n);
  assert.equal(formatAtomicUsdc(9007199254740993123456n), "9007199254740993.123456");
  assert.throws(() => parseUsdcAtomic("1.0000001"));
  assert.throws(() => parseUsdcAtomic("1e6"));
});

test("agent budget arithmetic stays atomic beyond Number.MAX_SAFE_INTEGER", () => {
  const limits = { ...defaultLimits(), maxPositionAtomic: "9007199254740993123456", maxDailyExposureAtomic: "9007199254740994123456" };
  const agent: AgentRecord = { schemaVersion: 1, agentId: "atomic", ownerWallet: "0x1", operatorWallet: "0x2", payoutWallet: "0x1", displayName: "Atomic", description: "", capabilities: ["council_juror"], authorityLevel: 3, limits, status: "active", reputationBps: 0, createdAt: 1, updatedAt: 1 };
  assert.equal(authorizeAction(agent, { capability: "council_juror", positionAtomic: "9007199254740993123456", exposureTodayAtomic: "1000000" }).allowed, true);
  assert.equal(authorizeAction(agent, { capability: "council_juror", positionAtomic: "9007199254740993123457" }).reason, "position_too_large");
});
