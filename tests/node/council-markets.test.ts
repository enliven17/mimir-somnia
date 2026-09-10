/**
 * The council's DreamDEX decision layer.
 *
 * The council used to read only the Mimir contract, where claimCount was 0, so
 * it logged "no joinable claims" every cycle and never took a position while
 * the market-creator kept filling DreamDEX. These cover the parts of the new
 * venue that decide whether money moves: the rules, the sizing, and the guards.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateMarketContrarian,
  evaluateMarketWhale,
  depth,
} from "../../agents/council/shared/market-rules";
import {
  marketCategory,
  sizeStake,
  runPersonaForMarket,
  type MarketExchange,
} from "../../agents/council/shared/market-runner";
import type { CouncilMarket } from "../../agents/council/shared/types";
import type { PersonaSpec } from "../../agents/council/personas";

function market(overrides: Partial<CouncilMarket> = {}): CouncilMarket {
  return {
    ref:            "BTC-100K",
    symbol:         "BTC-100K",
    question:       "Will Bitcoin trade above $100,000?",
    asset:          "BTC",
    oracleQuestion: null,
    category:       "crypto",
    expiry:         Math.floor(Date.now() / 1000) + 86_400,
    yesSymbol:      "BTC-100K#YES",
    noSymbol:       "BTC-100K#NO",
    yesProbability: 0.5,
    volume:         10,
    tradeCount:     4,
    ...overrides,
  };
}

const persona = { displayName: "Contrarian", stakeUsdc: 1.5 };

test("the contrarian fades a crowded price and picks the cheap side", () => {
  const long = evaluateMarketContrarian(persona, market({ yesProbability: 0.82 }));
  assert.equal(long.shouldBuy, true);
  assert.equal(long.outcome, "NO", "a crowded YES should be faded by buying NO");

  const short = evaluateMarketContrarian(persona, market({ yesProbability: 0.14 }));
  assert.equal(short.shouldBuy, true);
  assert.equal(short.outcome, "YES");
});

test("the contrarian sits out a coin flip and an untraded market", () => {
  const flip = evaluateMarketContrarian(persona, market({ yesProbability: 0.52 }));
  assert.equal(flip.shouldBuy, false);
  assert.equal(flip.skipReason, "abstain-no-edge");

  // No trades means no crowd — the price is the creator's, not the market's.
  const fresh = evaluateMarketContrarian(persona, market({ yesProbability: null, tradeCount: 0 }));
  assert.equal(fresh.shouldBuy, false);
});

test("depth values a book in collateral, not share count", () => {
  // 100 shares at 0.10 is 10 of collateral, not 100.
  assert.equal(depth([[0.1, 100]]), 10);
  assert.equal(depth([]), 0);
});

test("the whale follows the heavier side of the book", () => {
  const decision = evaluateMarketWhale(persona, market(), {
    yesBids: [[0.5, 200]], // 100 collateral
    noBids:  [[0.5, 20]],  // 10 collateral
  });
  assert.equal(decision.shouldBuy, true);
  assert.equal(decision.outcome, "YES");
});

test("the whale sits out balanced books, and an empty other side still counts", () => {
  const balanced = evaluateMarketWhale(persona, market(), {
    yesBids: [[0.5, 100]],
    noBids:  [[0.5, 95]],
  });
  assert.equal(balanced.shouldBuy, false);
  assert.equal(balanced.skipReason, "abstain-no-edge");

  // One side with nothing resting is the clearest signal there is; dividing by
  // that zero must not swallow it.
  const oneSided = evaluateMarketWhale(persona, market(), {
    yesBids: [[0.5, 100]],
    noBids:  [],
  });
  assert.equal(oneSided.shouldBuy, true);
  assert.equal(oneSided.outcome, "YES");

  const dead = evaluateMarketWhale(persona, market(), { yesBids: [], noBids: [] });
  assert.equal(dead.shouldBuy, false);
  assert.equal(dead.skipReason, "no-liquidity");
});

test("category tags let a specialist filter the venue's markets", () => {
  assert.match(marketCategory({ asset: "BTC", question: "Will Bitcoin top 100k?", oracleQuestion: null }), /crypto/);
  assert.match(
    marketCategory({ asset: "NYC", question: "Will the daily maximum temperature exceed 28C?", oracleQuestion: null }),
    /weather/,
  );
  // Nothing recognised must still be a tag, or a specialist filter matches
  // everything and the persona loses its character.
  assert.equal(marketCategory({ asset: "?", question: "Will something happen?", oracleQuestion: null }), "general");
});

test("sizing never drops below the base stake nor takes more than a tenth of the bankroll", () => {
  // Low confidence keeps the base stake.
  assert.equal(sizeStake(2, 100, 50, 75), 2);
  assert.equal(sizeStake(2, 100, undefined, 75), 2);

  // A confident bet scales up but stays inside the 10% cap.
  const sized = sizeStake(2, 100, 95, 75);
  assert.ok(sized >= 2, `expected at least the base stake, got ${sized}`);
  assert.ok(sized <= 10, `expected at most 10% of a 100 bankroll, got ${sized}`);

  // A small bankroll must not size below what the persona meant to bet.
  assert.equal(sizeStake(2, 5, 95, 75), 2);
});

/** Records orders instead of placing them. */
function spyExchange(bestAsk: number | null): MarketExchange & { orders: unknown[] } {
  const orders: unknown[] = [];
  return {
    orders,
    async fetchOrderBook() {
      return { bids: [[0.4, 10]], asks: bestAsk === null ? [] : [[bestAsk, 100] as [number, number]] };
    },
    async createOrder(symbol, type, side, amount, _price, params) {
      orders.push({ symbol, type, side, amount, params });
      return { txHash: "0xdeadbeef" };
    },
  };
}

const rulePersona = {
  slug: "contrarian",
  displayName: "Contrarian",
  archetype: "rule-based",
  ruleEvaluator: "contrarian",
  stakeUsdc: 1.5,
} as unknown as PersonaSpec;

test("a confident rule persona buys, sized in shares at the ask", async () => {
  const exchange = spyExchange(0.25);
  const receipt = await runPersonaForMarket({
    persona: rulePersona,
    market: market({ yesProbability: 0.85 }),
    exchange,
    bankrollUsdc: 50,
    engagedRefs: new Set(),
  });

  assert.ok(receipt, "expected a receipt");
  assert.equal(receipt.outcome, "NO");
  assert.equal(exchange.orders.length, 1);
  const order = exchange.orders[0] as { symbol: string; amount: number; side: string };
  assert.equal(order.side, "buy");
  assert.equal(order.symbol, "BTC-100K#NO");
  // 1.5 collateral at an ask of 0.25 is 6 shares — collateral is not the quantity.
  assert.equal(order.amount, 6);
});

test("guards refuse to spend: already positioned, thin bankroll, no ask", async () => {
  const positioned = spyExchange(0.25);
  assert.equal(
    await runPersonaForMarket({
      persona: rulePersona,
      market: market({ yesProbability: 0.85 }),
      exchange: positioned,
      bankrollUsdc: 50,
      engagedRefs: new Set(["btc-100k"]),
    }),
    null,
  );
  assert.equal(positioned.orders.length, 0, "must not add to a position it already holds");

  const broke = spyExchange(0.25);
  assert.equal(
    await runPersonaForMarket({
      persona: rulePersona,
      market: market({ yesProbability: 0.85 }),
      exchange: broke,
      bankrollUsdc: 2, // under the 2x buffer on a 1.5 stake
      engagedRefs: new Set(),
    }),
    null,
  );
  assert.equal(broke.orders.length, 0, "must keep a buffer instead of spending its last collateral");

  const illiquid = spyExchange(null);
  assert.equal(
    await runPersonaForMarket({
      persona: rulePersona,
      market: market({ yesProbability: 0.85 }),
      exchange: illiquid,
      bankrollUsdc: 50,
      engagedRefs: new Set(),
    }),
    null,
  );
  assert.equal(illiquid.orders.length, 0, "no ask means there is nothing to buy");
});

test("dry run decides but never orders", async () => {
  const exchange = spyExchange(0.25);
  const receipt = await runPersonaForMarket({
    persona: rulePersona,
    market: market({ yesProbability: 0.85 }),
    exchange,
    bankrollUsdc: 50,
    engagedRefs: new Set(),
    dryRun: true,
  });
  assert.equal(receipt, null);
  assert.equal(exchange.orders.length, 0);
});
