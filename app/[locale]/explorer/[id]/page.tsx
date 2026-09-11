import type { Metadata } from "next";

import DreamDexMarketBoard from "@/components/markets/DreamDexMarketBoard";

export const metadata: Metadata = {
  title: "Market · Mimir",
  description: "A binary event market: the book, the price, and your position.",
};

/**
 * One market, opened from the explorer.
 *
 * The board is the same component the listing used to be, focused on a single
 * market: the explorer answers "which question", this answers "at what price".
 * Splitting them that way is why /markets could collapse into /explorer without
 * losing the trading surface.
 */
export default async function MarketDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <DreamDexMarketBoard initialMarketId={decodeURIComponent(id)} focusOne />;
}
