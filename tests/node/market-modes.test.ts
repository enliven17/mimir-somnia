import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_VERSION,
  SETTLEMENT_MODE_POLICY,
  guardChallenge,
  isUnsupportedMode,
  selectableSettlementModes,
  settlementModeToOddsMode,
  toCanonicalMode,
  validateMode,
} from "../../lib/market-modes";

// ── on-chain → canonical ──────────────────────────────────────────────────────

test("a multi-slot pool market maps to pool", () => {
  const mode = toCanonicalMode({ marketType: "binary", oddsMode: "pool", maxChallengers: 100 });
  assert.equal(mode.subjectType, "binary");
  assert.equal(mode.settlementMode, "pool");
  assert.equal(isUnsupportedMode(mode), false);
});

test("a single-slot pool market IS a duel", () => {
  // The contract cannot express duel directly; one slot + equal stakes is the
  // v1 encoding, so the codec must recover it rather than showing pool math.
  const mode = toCanonicalMode({ marketType: "binary", oddsMode: "pool", maxChallengers: 1 });
  assert.equal(mode.settlementMode, "duel");
});

test("'fixed' maps to fixed_odds and stays fixed_odds at one slot", () => {
  assert.equal(
    toCanonicalMode({ marketType: "total", oddsMode: "fixed", maxChallengers: 100 }).settlementMode,
    "fixed_odds",
  );
  assert.equal(
    toCanonicalMode({ marketType: "total", oddsMode: "fixed", maxChallengers: 1 }).settlementMode,
    "fixed_odds",
  );
});

test("an unknown subject type degrades to custom without flagging unsupported", () => {
  const mode = toCanonicalMode({ marketType: "parlay", oddsMode: "pool", maxChallengers: 4 });
  assert.equal(mode.subjectType, "custom");
  assert.equal(isUnsupportedMode(mode), false);
});

test("an unknown odds mode is flagged unsupported, never silently pooled", () => {
  const mode = toCanonicalMode({ marketType: "binary", oddsMode: "dutch-book", maxChallengers: 4 });
  assert.equal(isUnsupportedMode(mode), true);
  assert.deepEqual(mode.unsupported, { marketType: "binary", oddsMode: "dutch-book" });
});

test("settlement mode round-trips through the on-chain odds string", () => {
  assert.equal(settlementModeToOddsMode("pool"), "pool");
  assert.equal(settlementModeToOddsMode("fixed_odds"), "fixed");
  // duel is escrowed as a one-slot pool
  assert.equal(settlementModeToOddsMode("duel"), "pool");
});

// ── validation: the combinations that must be rejected ────────────────────────

test("duel rejects a second challenger slot", () => {
  const result = validateMode({
    subjectType: "binary",
    settlementMode: "duel",
    maxChallengers: 2,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /at most 1 challenger/);
});

test("duel rejects unequal stakes", () => {
  const result = validateMode({
    subjectType: "binary",
    settlementMode: "duel",
    maxChallengers: 1,
    creatorStake: 10,
    challengerStake: 7,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /equal the creator stake/);
});

test("duel accepts one rival at an equal stake", () => {
  assert.deepEqual(
    validateMode({
      subjectType: "binary",
      settlementMode: "duel",
      maxChallengers: 1,
      creatorStake: 10,
      challengerStake: 10,
    }),
    { ok: true, errors: [] },
  );
});

test("fixed odds rejects a total return at or below 1x", () => {
  for (const bps of [0, 9_000, 10_000]) {
    const result = validateMode({
      subjectType: "binary",
      settlementMode: "fixed_odds",
      challengerPayoutBps: bps,
    });
    assert.equal(result.ok, false, `bps ${bps} should be rejected`);
    assert.match(result.errors.join(" "), /total return above 1x/);
  }
});

test("fixed odds rejects undercollateralised liquidity on profit, not gross payout", () => {
  // 2x on a 10 USDC stake owes 10 USDC of PROFIT. 8 of creator liquidity is short…
  const short = validateMode({
    subjectType: "binary",
    settlementMode: "fixed_odds",
    challengerPayoutBps: 20_000,
    creatorStake: 8,
    challengerStake: 10,
  });
  assert.equal(short.ok, false);
  assert.match(short.errors.join(" "), /undercollateralised/);

  // …and exactly 10 is enough, even though the gross payout is 20.
  assert.equal(
    validateMode({
      subjectType: "binary",
      settlementMode: "fixed_odds",
      challengerPayoutBps: 20_000,
      creatorStake: 10,
      challengerStake: 10,
    }).ok,
    true,
  );
});

test("a pool market may not carry fixed-odds bps", () => {
  const result = validateMode({
    subjectType: "binary",
    settlementMode: "pool",
    challengerPayoutBps: 20_000,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /does not use challengerPayoutBps/);
});

test("rematch_ladder requires a parent claim", () => {
  const orphan = validateMode({
    subjectType: "binary",
    settlementMode: "pool",
    productModifiers: ["rematch_ladder"],
  });
  assert.equal(orphan.ok, false);
  assert.match(orphan.errors.join(" "), /settled parent/);

  assert.equal(
    validateMode({
      subjectType: "binary",
      settlementMode: "pool",
      productModifiers: ["rematch_ladder"],
      parentId: 12,
    }).ok,
    true,
  );
});

test("unknown enum values are rejected rather than coerced", () => {
  const result = validateMode({
    subjectType: "parlay",
    settlementMode: "pool",
    productModifiers: ["moon_boost"],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /unknown subjectType/);
  assert.match(result.errors.join(" "), /unknown productModifier/);
});

// ── contract-version gating ───────────────────────────────────────────────────

test("squad_pool is refused on the v1 contract and is not selectable", () => {
  const result = validateMode({ subjectType: "binary", settlementMode: "squad_pool" });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /needs contract v2/);
  assert.equal(SETTLEMENT_MODE_POLICY.squad_pool.selectableOnCreate, false);
  assert.equal(
    selectableSettlementModes(CONTRACT_VERSION).some((p) => p.mode === "squad_pool"),
    false,
  );
});

test("the three live modes are selectable on the deployed contract", () => {
  assert.deepEqual(
    selectableSettlementModes(1).map((p) => p.mode),
    ["pool", "duel", "fixed_odds"],
  );
});

test("squad_pool becomes valid once a v2 contract is deployed", () => {
  assert.equal(
    validateMode({ subjectType: "binary", settlementMode: "squad_pool", contractVersion: 2 }).ok,
    true,
  );
});

// ── Write guard: the enforcement the v1 contract cannot do ────────────────────

test("a duel rejects a second rival", () => {
  const result = guardChallenge({
    settlementMode: "duel",
    creatorStake: 10,
    challengerStake: 10,
    existingChallengers: 1,
    maxChallengers: 1,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "duel_taken");
});

test("a duel rejects an unequal stake — the rule the contract cannot enforce in v1", () => {
  for (const stake of [9, 11, 2]) {
    const result = guardChallenge({
      settlementMode: "duel",
      creatorStake: 10,
      challengerStake: stake,
      existingChallengers: 0,
      maxChallengers: 1,
    });
    assert.equal(result.ok, false, `stake ${stake} should be rejected`);
    assert.equal(result.code, "duel_stake_mismatch");
  }
});

test("a duel accepts the first rival at an equal stake", () => {
  assert.equal(
    guardChallenge({
      settlementMode: "duel",
      creatorStake: 10,
      challengerStake: 10,
      existingChallengers: 0,
      maxChallengers: 1,
    }).ok,
    true,
  );
});

test("a pool market accepts unequal stakes but not an overfull book", () => {
  assert.equal(
    guardChallenge({
      settlementMode: "pool",
      creatorStake: 10,
      challengerStake: 3,
      existingChallengers: 4,
      maxChallengers: 10,
    }).ok,
    true,
  );
  const full = guardChallenge({
    settlementMode: "pool",
    creatorStake: 10,
    challengerStake: 3,
    existingChallengers: 10,
    maxChallengers: 10,
  });
  assert.equal(full.ok, false);
  assert.equal(full.code, "market_full");
});

test("fixed odds rejects a stake the creator's remaining liquidity cannot back", () => {
  // 2x on 10 owes 10 of profit; only 6 is unreserved.
  const short = guardChallenge({
    settlementMode: "fixed_odds",
    creatorStake: 20,
    challengerStake: 10,
    existingChallengers: 1,
    maxChallengers: 100,
    challengerPayoutBps: 20_000,
    availableCreatorLiquidity: 6,
  });
  assert.equal(short.ok, false);
  assert.equal(short.code, "insufficient_creator_liquidity");

  assert.equal(
    guardChallenge({
      settlementMode: "fixed_odds",
      creatorStake: 20,
      challengerStake: 10,
      existingChallengers: 1,
      maxChallengers: 100,
      challengerPayoutBps: 20_000,
      availableCreatorLiquidity: 10,
    }).ok,
    true,
  );
});

test("concurrent fixed-odds challenges exhaust the same liability only once", () => {
  const first = guardChallenge({
    settlementMode: "fixed_odds",
    creatorStake: 10,
    challengerStake: 6,
    existingChallengers: 0,
    maxChallengers: 100,
    challengerPayoutBps: 20_000,
    availableCreatorLiquidity: 10,
  });
  assert.equal(first.ok, true);

  // After the first transaction reserves 6, a competing 6-unit transaction
  // re-read against fresh state must fail instead of oversubscribing escrow.
  const raced = guardChallenge({
    settlementMode: "fixed_odds",
    creatorStake: 10,
    challengerStake: 6,
    existingChallengers: 1,
    maxChallengers: 100,
    challengerPayoutBps: 20_000,
    availableCreatorLiquidity: 4,
  });
  assert.equal(raced.ok, false);
  assert.equal(raced.code, "insufficient_creator_liquidity");
});

test("fixed odds with no multiple is refused rather than treated as 1x", () => {
  const result = guardChallenge({
    settlementMode: "fixed_odds",
    creatorStake: 20,
    challengerStake: 10,
    existingChallengers: 0,
    maxChallengers: 100,
    challengerPayoutBps: 0,
    availableCreatorLiquidity: 100,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "insufficient_creator_liquidity");
});

test("guard failures carry a machine-readable code for localisation", () => {
  const result = guardChallenge({
    settlementMode: "duel",
    creatorStake: 10,
    challengerStake: 5,
    existingChallengers: 0,
    maxChallengers: 1,
  });
  assert.ok(result.code, "the UI must not have to parse an English message");
  assert.ok(result.message);
});
