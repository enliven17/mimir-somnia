/**
 * Rule-based persona evaluators for DreamDEX binary markets — no LLM call.
 *
 * The Contrarian and the Whale-Watcher do not think; they react to what the
 * market already shows. That keeps two personas off the LLM rate limit and
 * produces bets that can be explained without a model transcript.
 *
 * On a claim these rules could only ever say "object" or "sit out", because a
 * persona cannot join a creator's side. A binary market has two tradeable
 * outcomes, so both rules now return a side.
 */

import type { CouncilMarket, MarketDecision, MarketOutcome } from "./types";

const DEFAULT_STAKE_USDC = 2;

/** Depth on one side of a book, in collateral. */
export function depth(levels: Array<[number, number]>): number {
  return levels.reduce((sum, [price, size]) => sum + price * size, 0);
}

/**
 * Contrarian: fade whatever the crowd has priced most confidently.
 *
 * A YES price of 0.8 is the crowd saying "almost certain". The Contrarian's
 * whole character is that such a price is more often overbought than right, so
 * it buys the cheap side. Needs a real lean — a market near 50/50 has no crowd
 * to fade, and acting there would just pay the spread.
 */
export function evaluateMarketContrarian(
  persona: { displayName: string; stakeUsdc?: number },
  market: CouncilMarket,
  { leanThreshold = 0.6 }: { leanThreshold?: number } = {},
): MarketDecision {
  const stakeUsdc = persona.stakeUsdc ?? DEFAULT_STAKE_USDC;

  if (market.yesProbability === null || market.tradeCount === 0) {
    return {
      shouldBuy: false,
      outcome:   null,
      stakeUsdc: 0,
      rationale: "Contrarian abstains: no trades yet, so there is no crowd to fade.",
      skipReason: "abstain-no-edge",
    };
  }

  const yes = market.yesProbability;
  const leaning: MarketOutcome | null =
    yes >= leanThreshold ? "NO" : yes <= 1 - leanThreshold ? "YES" : null;

  if (!leaning) {
    return {
      shouldBuy: false,
      outcome:   null,
      stakeUsdc: 0,
      rationale: `Contrarian abstains: YES at ${(yes * 100).toFixed(1)}% is too close to a coin flip to fade.`,
      skipReason: "abstain-no-edge",
    };
  }

  const crowdSide = leaning === "NO" ? "YES" : "NO";
  const crowdPct = leaning === "NO" ? yes * 100 : (1 - yes) * 100;
  return {
    shouldBuy: true,
    outcome:   leaning,
    stakeUsdc,
    rationale: `Contrarian: the crowd has ${crowdSide} at ${crowdPct.toFixed(1)}%. That is priced for certainty, so I buy ${leaning}.`,
  };
}

/**
 * Whale-Watcher: follow the side carrying the most resting money.
 *
 * On a claim this read the individual challenger stakes. A book has no named
 * stakers, so the proxy is bid depth: resting bids are money already committed
 * to a price, which is the closest thing to "someone has taken this side".
 * Needs a clear edge, since two similar books mean nobody has taken a stand.
 */
export function evaluateMarketWhale(
  persona: { displayName: string; stakeUsdc?: number },
  market: CouncilMarket,
  books: { yesBids: Array<[number, number]>; noBids: Array<[number, number]> },
  { edgeRatio = 1.5 }: { edgeRatio?: number } = {},
): MarketDecision {
  const stakeUsdc = persona.stakeUsdc ?? DEFAULT_STAKE_USDC;
  const yesDepth = depth(books.yesBids);
  const noDepth = depth(books.noBids);

  if (yesDepth === 0 && noDepth === 0) {
    return {
      shouldBuy: false,
      outcome:   null,
      stakeUsdc: 0,
      rationale: "Whale-Watcher waits: nothing resting on either side, no whale to follow.",
      skipReason: "no-liquidity",
    };
  }

  const [side, big, small]: [MarketOutcome, number, number] =
    yesDepth >= noDepth ? ["YES", yesDepth, noDepth] : ["NO", noDepth, yesDepth];

  // Guard the divide: an empty other side is an infinite ratio, which counts.
  if (small > 0 && big / small < edgeRatio) {
    return {
      shouldBuy: false,
      outcome:   null,
      stakeUsdc: 0,
      rationale: `Whale-Watcher abstains: bids are balanced (${yesDepth.toFixed(2)} YES vs ${noDepth.toFixed(2)} NO) — nobody has taken a stand.`,
      skipReason: "abstain-no-edge",
    };
  }

  return {
    shouldBuy: true,
    outcome:   side,
    stakeUsdc,
    rationale: `Whale-Watcher: ${big.toFixed(2)} collateral rests on ${side} against ${small.toFixed(2)} on the other side. I follow the money.`,
  };
}
