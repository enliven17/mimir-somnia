import assert from "node:assert/strict";
import test from "node:test";

import { toDreamDexMarket } from "../../lib/dreamdex-market";
import type { BinaryMarket, UnifiedMarket } from "@somnia-chain/markets-sdk";

const marketId = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const marketAddress = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;
const poolAddress = "0xcccccccccccccccccccccccccccccccccccccc" as `0x${string}`;

function fixture(): UnifiedMarket {
  const info = {
    id: marketId,
    marketType: "BINARY",
    poolAddress,
    lastPrice: "620000",
    lastTradeAt: "1700000000",
    cumulativeBaseVolume: "1250000",
    cumulativeQuoteVolume: "2500000",
    tradeCount: "17",
    baseDecimals: 6,
    quoteDecimals: 6,
    createdAtTimestamp: "1699999000",
    marketId,
    marketAddress,
    yesTokenId: "1",
    noTokenId: "2",
    collateral: "0xdddddddddddddddddddddddddddddddddddddd",
    asset: "BTC",
    question: "Will BTC close above the strike?",
    status: "Trading",
    oracleQuestion: "BTC close above strike",
    oracleQuestionId: "42",
    strike: "95000",
    tradingStart: "1699999500",
    expiry: "1700001000",
    winningOutcome: null,
    payoutNumerators: null,
    payoutDenominator: null,
    resolvedAtBlock: null,
    resolvedAtTimestamp: null,
    createdByTx: null,
    creator: null,
    voided: false,
    backing: "100000000",
    nonce: "3",
  } as unknown as BinaryMarket;

  return {
    id: marketId,
    symbol: "BTC-95000/USDC",
    type: "binary",
    base: "BTC-95000",
    quote: "USDC",
    settle: "USDC",
    active: true,
    contract: false,
    precision: { price: 6, amount: 6 },
    limits: { amount: { min: 0.000001 } },
    outcomes: [
      { symbol: "BTC-95000/USDC#YES", label: "YES", index: 0 },
      { symbol: "BTC-95000/USDC#NO", label: "NO", index: 1 },
    ],
    info,
  };
}

test("DreamDEX market DTO preserves market id and outcome symbols", () => {
  const normalized = toDreamDexMarket(fixture());

  assert.ok(normalized);
  assert.equal(normalized.id, marketId);
  assert.equal(normalized.poolAddress, poolAddress);
  assert.equal(normalized.yesSymbol, "BTC-95000/USDC#YES");
  assert.equal(normalized.noSymbol, "BTC-95000/USDC#NO");
  assert.equal(normalized.lastPrice, 0.62);
  assert.equal(normalized.volume, 2.5);
  assert.equal(normalized.tradingStart, 1699999500);
});

test("DreamDEX market DTO rejects non-binary unified markets", () => {
  const spot = { ...fixture(), type: "spot", info: { ...fixture().info, marketType: "SPOT" } } as unknown as UnifiedMarket;
  assert.equal(toDreamDexMarket(spot), null);
});
