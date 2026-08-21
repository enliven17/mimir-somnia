import type { Metadata } from "next";

import DreamDexMarketBoard from "@/components/markets/DreamDexMarketBoard";

export const metadata: Metadata = {
  title: "Markets · Mimir",
  description: "Discover and trade live binary event markets.",
};

export default function MarketsPage() {
  return <DreamDexMarketBoard />;
}
