/**
 * What the DreamDEX venue has actually done.
 *
 * The revenue page's other half is the Mimir contract's fee ledger, which only
 * fills once a VS claim settles. Every market the agents trade lives on
 * DreamDEX instead, so that half read zero however busy the venue was — the
 * page said "no revenue" while 300 trades sat in the book.
 *
 * No projection table behind this: the indexer already keeps settled outcomes,
 * volume and trade counts per market, and it is the historical record for that
 * venue. Reading it directly avoids a second copy that can fall behind, at the
 * cost of one indexer call per minute.
 *
 * Fees are deliberately absent. Mimir charges none on DreamDEX — it is the
 * protocol's venue, not ours — and inventing a number here would make the page
 * claim income that nobody collected.
 */

import { loadDreamDexMarkets } from "@/lib/dreamdex-market";
import { cachedFor } from "@/lib/server/ttl-cache";

export interface VenueRevenueSummary {
  /** Markets the protocol oracle has resolved. */
  settledMarkets: number;
  /** Resolved with no winning outcome — collateral returned. */
  voidedMarkets: number;
  /** Still taking orders. */
  liveMarkets: number;
  /** Every market the indexer knows about, settled or not. */
  totalMarkets: number;
  /** Collateral traded across all of them. */
  volumeCollateral: number;
  tradeCount: number;
  /** Newest first, for a table. */
  recentSettlements: Array<{
    symbol: string;
    asset: string;
    question: string;
    outcome: "YES" | "NO" | "VOID";
    resolvedAt: number | null;
    volumeCollateral: number;
    tradeCount: number;
  }>;
}

export const EMPTY_VENUE: VenueRevenueSummary = {
  settledMarkets: 0,
  voidedMarkets: 0,
  liveMarkets: 0,
  totalMarkets: 0,
  volumeCollateral: 0,
  tradeCount: 0,
  recentSettlements: [],
};

async function summarize(limit: number): Promise<VenueRevenueSummary> {
  // Settled markets are the point of this summary, and they are exactly the
  // ones an "active only" load leaves out.
  const markets = await loadDreamDexMarkets({ includeInactive: true });
  const nowSeconds = Math.floor(Date.now() / 1000);

  const settled = markets.filter((market) => market.resolvedAt !== null || market.voided);

  return {
    settledMarkets: settled.filter((market) => !market.voided).length,
    voidedMarkets: settled.filter((market) => market.voided).length,
    liveMarkets: markets.filter(
      (market) => market.status === "Trading" && market.expiry > nowSeconds,
    ).length,
    totalMarkets: markets.length,
    volumeCollateral: markets.reduce((sum, market) => sum + market.volume, 0),
    tradeCount: markets.reduce((sum, market) => sum + market.tradeCount, 0),
    recentSettlements: settled
      .slice()
      .sort((a, b) => (b.resolvedAt ?? b.expiry) - (a.resolvedAt ?? a.expiry))
      .slice(0, limit)
      .map((market) => ({
        symbol: market.symbol,
        asset: market.asset,
        question: market.question,
        outcome: market.voided ? "VOID" : market.winningOutcome === 1 ? "NO" : "YES",
        resolvedAt: market.resolvedAt,
        volumeCollateral: market.volume,
        tradeCount: market.tradeCount,
      })),
  };
}

/**
 * One indexer round trip per minute, shared by every concurrent reader. The
 * numbers move as markets settle, not as the page is refreshed.
 */
const cached = cachedFor(summarize, 60_000);

export async function getVenueRevenueSummary(limit = 10): Promise<VenueRevenueSummary> {
  try {
    return await cached(limit);
  } catch {
    // The page's other halves are independent; an unreachable indexer must not
    // take the whole route down.
    return EMPTY_VENUE;
  }
}
