/**
 * Per-persona evaluation + order placement on a DreamDEX binary market.
 *
 * Mirrors persona-runner.ts, which does the same job for VS claims on the Mimir
 * contract. Both venues share the persona specs, the confidence thresholds and
 * the Kelly sizing; what differs is the guard set (a book position instead of an
 * on-chain hasChallenged flag) and the move (a bounded market buy instead of
 * approve + challengeClaim).
 */

import { createThrottle } from "../../../lib/agent-bootstrap";
import { kellyFraction } from "../../../lib/kelly";
import type { DreamDexMarket } from "../../../lib/dreamdex-market";
import type { PersonaSpec } from "../personas";
import { evaluateMarketAsPersona } from "./market-llm";
import { evaluateMarketContrarian, evaluateMarketWhale } from "./market-rules";
import type {
  CouncilMarket,
  MarketBuyReceipt,
  MarketDecision,
  MarketOutcome,
} from "./types";

const DEFAULT_MIN_CONFIDENCE = 75;
const DEFAULT_STAKE_USDC     = 2;

/** Same budget the claim runner uses — one shared Gemini bucket per process. */
const LLM_THROTTLE_MS = Number(process.env.COUNCIL_LLM_THROTTLE_MS ?? 8000);
const throttleLlm = createThrottle(LLM_THROTTLE_MS);

/** Conservative Kelly cap: personas play across many markets at once. */
const KELLY_CAP = 0.15;

/** Slippage allowed on a market buy, as a fraction of the quoted ask. */
const SLIPPAGE = 0.03;

/**
 * Keyword tags so specialist personas filter markets the way they filter
 * claims. DreamDEX markets carry an asset and a question but no category, and a
 * specialist with nothing to match on would silently evaluate everything —
 * which is exactly the failure that retires a persona's character.
 */
const CATEGORY_KEYWORDS: Array<[string, RegExp]> = [
  ["crypto",  /\b(btc|bitcoin|eth|ethereum|sol|solana|token|defi|stablecoin|altcoin)\b/i],
  ["sports",  /\b(nba|nfl|mlb|soccer|football|tennis|f1|match|cup|league)\b/i],
  ["weather", /\b(temperature|rain|snow|storm|hurricane|climate|weather|celsius)\b/i],
  ["equity",  /\b(aapl|nasdaq|stock|shares|earnings)\b/i],
  ["space",   /\b(launch|falcon|rocket|starship|orbit|mission)\b/i],
];

export function marketCategory(market: {
  asset: string;
  question: string;
  oracleQuestion: string | null;
}): string {
  const haystack = `${market.asset} ${market.question} ${market.oracleQuestion ?? ""}`;
  const tags = CATEGORY_KEYWORDS
    .filter(([, pattern]) => pattern.test(haystack))
    .map(([tag]) => tag);
  return tags.length > 0 ? tags.join(",") : "general";
}

/** The narrow view a persona is allowed to reason about. */
export function toCouncilMarket(market: DreamDexMarket): CouncilMarket {
  return {
    ref:            market.symbol,
    symbol:         market.symbol,
    question:       market.question,
    asset:          market.asset,
    oracleQuestion: market.oracleQuestion,
    category:       marketCategory(market),
    expiry:         market.expiry,
    yesSymbol:      market.yesSymbol,
    noSymbol:       market.noSymbol,
    yesProbability: market.lastPrice,
    volume:         market.volume,
    tradeCount:     market.tradeCount,
  };
}

function categoryMatches(persona: PersonaSpec, market: CouncilMarket): boolean {
  if (!persona.categoryFilter || persona.categoryFilter.length === 0) return true;
  const category = market.category.toLowerCase();
  return persona.categoryFilter.some((tag) => category.includes(tag.toLowerCase()));
}

/** Minimal slice of the exchange this module needs, so it can be tested. */
export interface MarketExchange {
  fetchOrderBook(
    symbol: string,
    limit?: number,
  ): Promise<{ bids: Array<[number, number]>; asks: Array<[number, number]> }>;
  /** Snap a price to the pool's tick grid. */
  priceToPrecision(symbol: string, price: number): number;
  /** Snap a quantity to the pool's lot grid. */
  amountToPrecision(symbol: string, amount: number): number;
  createOrder(
    symbol: string,
    type: "limit",
    side: "buy",
    amount: number,
    price: number,
    params?: Record<string, unknown>,
  ): Promise<{ id?: string; txHash?: string | null }>;
}

/**
 * Cross the book with a price the pool will actually accept.
 *
 * The venue rejects any price off its tick grid — `InvalidPrice(304750, 1000)`
 * is a price of 0.30475 against a tick of 0.001 — and the SDK's own "market"
 * order type derives its crossing price from the book without snapping it,
 * which reverted every buy the council decided to make. So the crossing price
 * is built here, snapped, and sent as an IOC limit order: same taker behaviour,
 * a price the pool can take.
 *
 * Snapping rounds down, so the slippage margin has to be wider than one tick or
 * the rounded price can land back under the ask and never fill.
 */
export function crossingPrice(
  exchange: Pick<MarketExchange, "priceToPrecision">,
  symbol: string,
  bestAsk: number,
  slippage: number,
): number {
  return exchange.priceToPrecision(symbol, Math.min(bestAsk * (1 + slippage), 0.999));
}

/**
 * Decision only — no order. Kept separate so a route can show what a persona
 * thinks about a market without spending its money.
 */
export async function evaluatePersonaForMarket(
  persona: PersonaSpec,
  market: CouncilMarket,
  exchange: Pick<MarketExchange, "fetchOrderBook">,
  peerReasoning: string[] = [],
): Promise<MarketDecision> {
  if (!categoryMatches(persona, market)) {
    return {
      shouldBuy: false,
      outcome:   null,
      stakeUsdc: 0,
      rationale: `${persona.displayName} only watches ${persona.categoryFilter?.join(" / ")} markets — this one is out of scope.`,
      skipReason: "category-filter",
    };
  }

  if (persona.archetype === "rule-based") {
    if (persona.ruleEvaluator === "contrarian") {
      return evaluateMarketContrarian(persona, market);
    }
    if (persona.ruleEvaluator === "whale-follow") {
      const [yesBook, noBook] = await Promise.all([
        exchange.fetchOrderBook(market.yesSymbol, 10),
        exchange.fetchOrderBook(market.noSymbol, 10),
      ]);
      return evaluateMarketWhale(persona, market, {
        yesBids: yesBook.bids,
        noBids:  noBook.bids,
      });
    }
    return {
      shouldBuy: false,
      outcome:   null,
      stakeUsdc: 0,
      rationale: `${persona.displayName} has no rule evaluator wired.`,
      skipReason: "abstain-no-edge",
    };
  }

  let verdict;
  try {
    await throttleLlm();
    verdict = await evaluateMarketAsPersona(persona, market, peerReasoning);
  } catch (err) {
    return {
      shouldBuy: false,
      outcome:   null,
      stakeUsdc: 0,
      rationale: `${persona.displayName}: LLM call failed (${err instanceof Error ? err.message : "unknown"}).`,
      skipReason: "llm-failed",
    };
  }

  const minConf = persona.minConfidence ?? DEFAULT_MIN_CONFIDENCE;

  if (verdict.verdict === "ABSTAIN" || verdict.confidence < minConf) {
    return {
      shouldBuy: false,
      outcome:   null,
      stakeUsdc: 0,
      rationale: `${persona.displayName} stands aside: ${verdict.verdict} at ${verdict.confidence}% (threshold ${minConf}%). ${verdict.explanation}`,
      confidence: verdict.confidence,
      skipReason: verdict.verdict === "ABSTAIN" ? "abstain-no-edge" : "abstain-low-confidence",
    };
  }

  return {
    shouldBuy:  true,
    outcome:    verdict.verdict,
    stakeUsdc:  persona.stakeUsdc ?? DEFAULT_STAKE_USDC,
    rationale:  `${persona.displayName} buys ${verdict.verdict}: ${verdict.explanation}`,
    confidence: verdict.confidence,
  };
}

/**
 * Kelly-size a confident bet against the wallet's own collateral.
 *
 * Never below the persona's base stake (a persona that has just been funded
 * should still be able to act) and never above a tenth of the bankroll, so one
 * market cannot become the whole book.
 */
export function sizeStake(
  baseStakeUsdc: number,
  bankrollUsdc: number,
  confidence: number | undefined,
  minConfidence: number,
): number {
  if (!confidence || confidence < minConfidence) return baseStakeUsdc;
  const kelly = kellyFraction(confidence, KELLY_CAP);
  const sized = Math.max(baseStakeUsdc, Math.min(bankrollUsdc * kelly, bankrollUsdc * 0.1));
  return Math.round(sized * 100) / 100;
}

/**
 * Full pipeline for one persona on one market: guards, decision, order.
 * Returns a receipt when collateral was actually committed, null otherwise.
 */
export async function runPersonaForMarket(args: {
  persona:        PersonaSpec;
  market:         CouncilMarket;
  exchange:       MarketExchange;
  bankrollUsdc:   number;
  /** Markets this persona already holds or has a resting order on. */
  engagedRefs:    Set<string>;
  peerReasoning?: string[];
  dryRun?:        boolean;
}): Promise<MarketBuyReceipt | null> {
  const {
    persona,
    market,
    exchange,
    bankrollUsdc,
    engagedRefs,
    peerReasoning = [],
    dryRun = false,
  } = args;

  // One position per persona per market: buying again would average into a bet
  // the persona already sized, and the rationale on record would no longer
  // describe the position.
  if (engagedRefs.has(market.ref.toLowerCase())) return null;

  const baseStakeUsdc = persona.stakeUsdc ?? DEFAULT_STAKE_USDC;
  // Keep a 2x buffer so a persona never commits its last collateral.
  if (bankrollUsdc < baseStakeUsdc * 2) {
    console.log(
      `[council:${persona.slug}] insufficient collateral (${bankrollUsdc.toFixed(2)}), skipping`,
    );
    return null;
  }

  const decision = await evaluatePersonaForMarket(persona, market, exchange, peerReasoning);
  console.log(
    `[council:${persona.slug}] ${market.ref} ${decision.outcome ?? decision.skipReason ?? "pass"}` +
    `${decision.confidence !== undefined ? ` ${decision.confidence}%` : ""} · ${decision.rationale.slice(0, 110)}`,
  );
  if (!decision.shouldBuy || !decision.outcome) return null;

  const outcome: MarketOutcome = decision.outcome;
  const symbol = outcome === "YES" ? market.yesSymbol : market.noSymbol;
  const stakeUsdc = sizeStake(
    decision.stakeUsdc,
    bankrollUsdc,
    decision.confidence,
    persona.minConfidence ?? DEFAULT_MIN_CONFIDENCE,
  );

  if (dryRun) {
    console.log(
      `[council:${persona.slug}]   DRY RUN — would buy ${outcome} on ${market.ref} for ${stakeUsdc}`,
    );
    return null;
  }

  // Size in shares, not collateral: the venue takes a share quantity, and the
  // ask is what turns one into the other. No ask means nothing to buy.
  const book = await exchange.fetchOrderBook(symbol, 5);
  const bestAsk = book.asks[0]?.[0];
  if (!bestAsk || bestAsk <= 0) {
    console.log(`[council:${persona.slug}]   ${market.ref} has no ask on ${outcome}, skipping`);
    return null;
  }

  const price = crossingPrice(exchange, symbol, bestAsk, SLIPPAGE);
  const quantity = exchange.amountToPrecision(symbol, stakeUsdc / price);
  if (!(quantity > 0)) {
    console.log(
      `[council:${persona.slug}]   ${market.ref} stake of ${stakeUsdc} is under one lot at ${price}, skipping`,
    );
    return null;
  }

  const order = await exchange.createOrder(symbol, "limit", "buy", quantity, price, {
    timeInForce: "IOC",
  });
  const txHash = order.txHash ?? order.id ?? "";

  console.log(
    `[council:${persona.slug}] ✓ bought ${outcome} on ${market.ref} for ${stakeUsdc} collateral ` +
    `(${quantity.toFixed(4)} @ ${price.toFixed(4)}) — ${txHash}`,
  );

  return { persona, ref: market.ref, outcome, stakeUsdc, txHash, rationale: decision.rationale };
}
