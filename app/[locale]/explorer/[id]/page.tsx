import type { Metadata } from "next";
import { notFound } from "next/navigation";

import DreamDexMarketBoard from "@/components/markets/DreamDexMarketBoard";
import CouncilMarketBets from "@/components/markets/CouncilMarketBets";
import { getDreamDexMarket } from "@/lib/dreamdex-market";
import { listVenuePositions, type VenuePositionRow } from "@/lib/db";

export const metadata: Metadata = {
  title: "Market · Mimir",
  description: "A binary event market: the book, the price, and the council's side of it.",
};

// The book and the council's fills both move between renders; caching this page
// would show a stale price next to a live order form.
export const dynamic = "force-dynamic";

/** Same shape as a VS claim page: main column argues, sidebar shows who agreed. */
export default async function MarketDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ref = decodeURIComponent(id);

  const market = await getDreamDexMarket(ref)
    .then((result) => result.market)
    .catch((error: unknown) => {
      // A market the venue has rolled past and an indexer that is merely
      // unreachable both end up here as a 404, and they are indistinguishable
      // from the outside unless the reason is written down.
      console.error("[explorer] market lookup failed for", ref, error);
      return null;
    });
  if (!market) notFound();

  // A market with no database behind it is still a tradeable market.
  const positions: VenuePositionRow[] = await listVenuePositions({
    marketRef: market.symbol,
    limit: 100,
  }).catch(() => []);

  const expired = market.expiry * 1000 <= Date.now();
  // The venue keeps calling an expired market "Trading" until it settles, so the
  // clock is the honest signal here, not the status field.
  const live = market.status === "Trading" && !expired;
  const yes = market.lastPrice === null ? null : Math.round(market.lastPrice * 1000) / 10;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
      <section className="card mb-6 border-pv-ink/[0.12] bg-pv-surface p-5 sm:mb-8 sm:p-8">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 sm:mb-6">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={
                live
                  ? "font-display text-xs font-semibold uppercase tracking-wide text-pv-emerald bg-pv-emerald/10 px-2 py-1"
                  : "font-display text-xs font-semibold uppercase tracking-wide text-pv-muted bg-pv-ink/[0.06] px-2 py-1 ring-1 ring-pv-ink/[0.08]"
              }
            >
              {live ? "trading" : expired ? "settling" : market.status.toLowerCase()}
            </span>
            <span className="font-display text-xs font-semibold uppercase tracking-wide text-pv-muted bg-pv-ink/[0.06] px-2 py-1 ring-1 ring-pv-ink/[0.08]">
              binary · {market.asset}
            </span>
          </div>
          <span className="rounded px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-pv-muted ring-1 ring-pv-ink/[0.1]">
            {market.symbol}
          </span>
        </div>

        <h1 className="mb-6 font-display text-[clamp(26px,7vw,44px)] font-bold uppercase leading-[0.95] tracking-tight sm:mb-7">
          {market.question || market.symbol}
        </h1>

        {/* The two sides, in the same opposition block a VS claim uses — except
            here the split is the crowd's price, not a creator and a challenger. */}
        <div className="flex flex-col overflow-hidden rounded-xl border border-pv-ink/[0.12] sm:flex-row">
          <div className="flex-1 bg-pv-emerald/[0.05] p-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-pv-emerald/70">
              yes
            </p>
            <p className="mt-1 font-display text-3xl font-bold tabular-nums text-pv-emerald">
              {yes === null ? "—" : `${yes.toFixed(1)}%`}
            </p>
          </div>
          <div className="flex-1 bg-pv-gold/[0.05] p-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-pv-gold/70">no
            </p>
            <p className="mt-1 font-display text-3xl font-bold tabular-nums text-pv-gold">
              {yes === null ? "—" : `${(100 - yes).toFixed(1)}%`}
            </p>
          </div>
        </div>

        <dl className="mt-5 flex flex-wrap gap-x-6 gap-y-2 font-mono text-[10px] uppercase tracking-[0.16em] text-pv-muted">
          <div className="flex gap-1">
            <dt>expiry</dt>
            <dd className="text-pv-text">
              {new Date(market.expiry * 1000).toISOString().slice(0, 16).replace("T", " ")}Z
            </dd>
          </div>
          <div className="flex gap-1">
            <dt>volume</dt>
            <dd className="tabular-nums text-pv-text">{market.volume.toFixed(2)}</dd>
          </div>
          <div className="flex gap-1">
            <dt>trades</dt>
            <dd className="tabular-nums text-pv-text">{market.tradeCount}</dd>
          </div>
        </dl>
      </section>

      <div className="grid gap-6 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-8">
          <DreamDexMarketBoard initialMarketId={market.id} focusOne />
        </div>
        <aside className="min-w-0 lg:col-span-4">
          <div className="lg:sticky lg:top-24">
            <CouncilMarketBets positions={positions} />
          </div>
        </aside>
      </div>
    </div>
  );
}
