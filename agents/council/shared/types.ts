/**
 * Shared types for the Mimir Council runtime.
 */

import type { PublicClient } from "viem";
import type { PersonaSpec } from "../personas";

/**
 * On-chain claim shape consumed by the runner. Mirrors the relevant subset
 * of getClaim + getClaimMarketConfig outputs.
 */
export interface ClaimOnChain {
  id:                   number;
  creator:              string;
  question:             string;
  creatorPosition:      string;
  counterPosition:      string;
  resolutionUrl:        string;
  creatorStake:         bigint;
  totalChallengerStake: bigint;
  deadline:             bigint;
  state:                number;
  category:             string;
  marketType:           string;
  challengerCount:      bigint;
  maxChallengers:       bigint;
  isPrivate:            boolean;
  settlementRule:       string;
}

/**
 * What a persona decides about a single claim in a single cycle.
 *
 * Personas can only join the challenger side (createClaim is the
 * market-creator's role). When a persona's analysis agrees with the
 * creator's position, the persona simply abstains.
 */
export interface PersonaDecision {
  shouldStake:   boolean;
  /** USDC amount staked. Only meaningful when shouldStake is true. */
  stakeUsdc:     number;
  /** Human-readable reason — surfaced in the activity log and /council. */
  rationale:     string;
  /** Optional LLM confidence (0-100) for callers that want to display it. */
  confidence?:   number;
  /** Reason for skipping when shouldStake is false. For observability. */
  skipReason?:
    | "category-filter"
    | "abstain-low-confidence"
    | "abstain-agrees-with-creator"
    | "already-challenged"
    | "self-created"
    | "private"
    | "full"
    | "insufficient-balance"
    | "no-pool-imbalance"
    | "no-whale-yet"
    | "no-evidence"
    | "llm-failed";
}

export interface PersonaRunnerContext {
  publicClient:     PublicClient;
  contractAddress:  `0x${string}`;
  evidenceCache:    Map<number, EvidenceCacheEntry>;
  peerReasoning?:   Map<string, string[]>;
}

export interface EvidenceCacheEntry {
  text:    string;
  fetcher: string;
  hash:    `0x${string}`;
}

export interface PersonaStakeReceipt {
  persona:   PersonaSpec;
  claimId:   number;
  stakeUsdc: number;
  txHash:    string;
  rationale: string;
}

// ── DreamDEX binary markets ───────────────────────────────────────────────────
// The council votes on two venues. VS claims (above) are head-to-head positions
// users open on the Mimir contract, where a persona can only join the challenger
// side. DreamDEX binary markets are the protocol's own event contracts, where
// both outcomes are tradeable — so a persona picks a side rather than deciding
// whether to object to someone else's.

/** Which outcome a persona would buy. */
export type MarketOutcome = "YES" | "NO";

/**
 * The market view a persona reasons about. Narrower than DreamDexMarket on
 * purpose: the decision layer should not be able to reach for pool internals or
 * raw protocol fields, so what it may consider is written down here.
 */
export interface CouncilMarket {
  /** Market reference used for ordering and logs. */
  ref:            string;
  symbol:         string;
  question:       string;
  asset:          string;
  /** The rule the protocol oracle settles by, when the market states one. */
  oracleQuestion: string | null;
  /** Derived tags, so specialist personas can filter as they do for claims. */
  category:       string;
  /** Unix seconds. */
  expiry:         number;
  yesSymbol:      string;
  noSymbol:       string;
  /** Last traded YES price in [0,1] — the market's own probability. */
  yesProbability: number | null;
  volume:         number;
  tradeCount:     number;
}

/** What a persona decides about one market in one cycle. */
export interface MarketDecision {
  shouldBuy:   boolean;
  /** Only meaningful when shouldBuy is true. */
  outcome:     MarketOutcome | null;
  /** Collateral to spend. */
  stakeUsdc:   number;
  rationale:   string;
  confidence?: number;
  skipReason?:
    | "category-filter"
    | "abstain-low-confidence"
    | "abstain-no-edge"
    | "already-positioned"
    | "not-trading"
    | "expiring"
    | "insufficient-balance"
    | "no-liquidity"
    | "llm-failed";
}

export interface MarketBuyReceipt {
  persona:   PersonaSpec;
  ref:       string;
  outcome:   MarketOutcome;
  stakeUsdc: number;
  txHash:    string;
  rationale: string;
}
