import assert from "node:assert/strict";
import test from "node:test";

import {
  FEATURES,
  NEVER_PAUSABLE,
  PAUSABLE,
  checkWriteAllowed,
  disabledCategories,
  isCategoryEnabled,
  gatedFeatures,
  isFeature,
  isFeatureEnabled,
  isNeverPausable,
  isPausable,
  isPaused,
  pauseState,
  pausedCapabilities,
} from "../../lib/ops/flags";

type Env = Record<string, string | undefined>;

// ── Independent pausing is the whole point ────────────────────────────────────

test("pausing stake does not pause anything else", () => {
  // If a pricing bug is found you stop new stakes without freezing payouts or
  // taking the paid endpoints down.
  const env: Env = { MIMIR_PAUSE_STAKE: "1" };
  assert.equal(isPaused("stake", env), true);
  assert.equal(isPaused("create_market", env), false);
  assert.equal(isPaused("x402_selling", env), false);
  assert.equal(isPaused("oracle_settlement", env), false);
});

test("pausing x402 selling leaves settlement and withdrawal alone", () => {
  // The facilitator being down should not stop people settling.
  const env: Env = { MIMIR_PAUSE_X402_SELLING: "1" };
  assert.equal(isPaused("x402_selling", env), true);
  assert.equal(isPaused("oracle_settlement", env), false);
  assert.equal(isPaused("stake", env), false);
});

test("each pausable capability has its own switch", () => {
  for (const capability of PAUSABLE) {
    const env: Env = { [`MIMIR_PAUSE_${capability.toUpperCase()}`]: "1" };
    assert.equal(isPaused(capability, env), true, `${capability} has no switch`);
    // …and it pauses only itself.
    const others = PAUSABLE.filter((other) => other !== capability);
    for (const other of others) {
      assert.equal(isPaused(other, env), false, `${capability} also paused ${other}`);
    }
  }
});

test("pausedCapabilities lists exactly what is down", () => {
  const env: Env = { MIMIR_PAUSE_STAKE: "1", MIMIR_PAUSE_COPY_EXECUTION: "1" };
  assert.deepEqual(pausedCapabilities(env).sort(), ["copy_execution", "stake"]);
});

test("nothing is paused by default", () => {
  assert.deepEqual(pausedCapabilities({}), []);
});

// ── The global switch, and its limits ─────────────────────────────────────────

test("the global switch pauses every pausable capability", () => {
  const env: Env = { MIMIR_PAUSE_ALL: "1" };
  assert.deepEqual(pausedCapabilities(env).sort(), [...PAUSABLE].sort());
  assert.equal(pauseState("stake", env).viaGlobal, true);
});

test("a specific pause is reported as specific, not global", () => {
  const state = pauseState("stake", { MIMIR_PAUSE_STAKE: "1" });
  assert.equal(state.viaGlobal, false);
});

test("withdrawal and reads are structurally not pausable", () => {
  // Users must always be able to pull a parked payout, even mid-incident, and a
  // status page nobody can reach is not a status page.
  for (const capability of NEVER_PAUSABLE) {
    assert.equal(isNeverPausable(capability), true);
    assert.equal(isPausable(capability), false, `${capability} must have no switch`);
  }
  assert.ok(NEVER_PAUSABLE.includes("withdraw"));
  assert.ok(NEVER_PAUSABLE.includes("read_markets"));
});

test("the pausable and never-pausable sets do not overlap", () => {
  for (const capability of PAUSABLE) {
    assert.equal(isNeverPausable(capability), false, `${capability} is in both sets`);
  }
});

// ── Reasons are surfaced ──────────────────────────────────────────────────────

test("a capability-specific reason is preferred over the global one", () => {
  const state = pauseState("stake", {
    MIMIR_PAUSE_STAKE: "1",
    MIMIR_PAUSE_STAKE_REASON: "payout preview mismatch under investigation",
    MIMIR_PAUSE_REASON: "generic",
  });
  assert.equal(state.reason, "payout preview mismatch under investigation");
});

test("the global reason is used when there is no specific one", () => {
  const state = pauseState("stake", { MIMIR_PAUSE_ALL: "1", MIMIR_PAUSE_REASON: "RPC degraded" });
  assert.equal(state.reason, "RPC degraded");
});

// ── Feature flags are distinct from pauses ────────────────────────────────────

test("money-moving features without a per-action signature default OFF", () => {
  // A flag is not a substitute for the roadmap's review gate.
  assert.equal(isFeatureEnabled("copy_trading", {}), false);
  assert.equal(isFeatureEnabled("agent_baskets", {}), false);
  assert.equal(isFeatureEnabled("byoa_funded_actions", {}), false);
});

test("shipped read-side features default ON", () => {
  for (const feature of [
    "duel_mode",
    "fixed_odds",
    "underdog_discovery",
    "rematch_ladder",
    "reasoning_feed",
    "share_cards",
    "byoa_registry",
    "virtual_baskets",
  ] as const) {
    assert.equal(isFeatureEnabled(feature, {}), true, `${feature} should be on`);
  }
});

test("gatedFeatures names exactly what still needs a review gate", () => {
  assert.deepEqual(gatedFeatures().sort(), [
    "agent_baskets",
    "byoa_funded_actions",
    "copy_trading",
    // Fees only exist in MimirV2, which is unaudited and holds nothing yet.
    "fee_policy",
  ]);
});

test("a flag can be forced on or off explicitly", () => {
  assert.equal(isFeatureEnabled("copy_trading", { MIMIR_FEATURE_COPY_TRADING: "1" }), true);
  assert.equal(isFeatureEnabled("duel_mode", { MIMIR_FEATURE_DUEL_MODE: "0" }), false);
});

test("an unrecognised flag value falls back to the default", () => {
  // "true"/"yes" are not accepted, so a typo cannot silently enable copy trading.
  assert.equal(isFeatureEnabled("copy_trading", { MIMIR_FEATURE_COPY_TRADING: "true" }), false);
  assert.equal(isFeatureEnabled("copy_trading", { MIMIR_FEATURE_COPY_TRADING: "yes" }), false);
});

test("feature and capability names are validated", () => {
  for (const feature of FEATURES) assert.equal(isFeature(feature), true);
  assert.equal(isFeature("drain_treasury"), false);
  assert.equal(isPausable("stake"), true);
  assert.equal(isPausable("withdraw"), false);
});

// ── The single write gate ─────────────────────────────────────────────────────

test("a write passes when its feature is on and nothing is paused", () => {
  assert.deepEqual(checkWriteAllowed({ feature: "duel_mode", capability: "create_market" }, {}), {
    allowed: true,
  });
});

test("a disabled feature blocks before a pause is even considered", () => {
  // "not available yet" is truer than "temporarily paused" for something that was
  // never enabled.
  const result = checkWriteAllowed(
    { feature: "copy_trading", capability: "copy_execution" },
    { MIMIR_PAUSE_COPY_EXECUTION: "1" },
  );
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "feature_disabled");
});

test("a paused capability blocks an enabled feature, with the operator's reason", () => {
  const result = checkWriteAllowed(
    { feature: "duel_mode", capability: "stake" },
    { MIMIR_PAUSE_STAKE: "1", MIMIR_PAUSE_STAKE_REASON: "settling a payout dispute" },
  );
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "paused");
  assert.equal(result.detail, "settling a payout dispute");
});

test("a pause with no reason still explains itself", () => {
  const result = checkWriteAllowed({ capability: "stake" }, { MIMIR_PAUSE_STAKE: "1" });
  assert.equal(result.allowed, false);
  assert.match(result.detail ?? "", /stake is temporarily paused/);
});

test("a global pause says so in the message", () => {
  const result = checkWriteAllowed({ capability: "stake" }, { MIMIR_PAUSE_ALL: "1" });
  assert.match(result.detail ?? "", /all writes/);
});

test("a capability with no feature flag is gated by the pause alone", () => {
  assert.equal(checkWriteAllowed({ capability: "oracle_settlement" }, {}).allowed, true);
  assert.equal(
    checkWriteAllowed({ capability: "oracle_settlement" }, { MIMIR_PAUSE_ORACLE_SETTLEMENT: "1" })
      .allowed,
    false,
  );
});

// ── Per-category kill switch ─────────────────────────────────────────────

test("a category is enabled unless an operator switched it off", () => {
  // Disable-list, not allow-list: an allow-list kept in sync by hand silently
  // drops a new category the day it ships.
  assert.equal(isCategoryEnabled("crypto", {}), true);
  assert.equal(isCategoryEnabled("crypto", { MIMIR_DISABLE_CATEGORY_CRYPTO: "1" }), false);
});

test("category keys are normalised so a dashed id still maps to its switch", () => {
  assert.equal(isCategoryEnabled("macro-data", { MIMIR_DISABLE_CATEGORY_MACRO_DATA: "1" }), false);
  assert.equal(isCategoryEnabled(" Crypto ", { MIMIR_DISABLE_CATEGORY_CRYPTO: "1" }), false);
});

test("an empty category id is refused rather than treated as enabled", () => {
  assert.equal(isCategoryEnabled("  ", {}), false);
});

test("disabledCategories lists what an operator switched off", () => {
  assert.deepEqual(
    disabledCategories(["crypto", "sports", "macro"], { MIMIR_DISABLE_CATEGORY_SPORTS: "1" }),
    ["sports"],
  );
});

test("a disabled category blocks a write whose feature is on", () => {
  const result = checkWriteAllowed(
    { feature: "duel_mode", capability: "create_market", category: "sports" },
    { MIMIR_DISABLE_CATEGORY_SPORTS: "1" },
  );
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "category_disabled");
});

test("a category switch does not affect writes that name no category", () => {
  // Settling an existing market must not be blocked by a creation-side switch,
  // or disabling a category would trap the funds already staked in it.
  assert.equal(
    checkWriteAllowed(
      { capability: "oracle_settlement" },
      { MIMIR_DISABLE_CATEGORY_SPORTS: "1" },
    ).allowed,
    true,
  );
});
