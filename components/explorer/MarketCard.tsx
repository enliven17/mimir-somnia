"use client";

/**
 * A DreamDEX binary market, in the explorer's grid.
 *
 * Not an ArenaCard: that card is built around a VS claim — a creator's stake, a
 * challenger pool, odds mode, a seat count — and a binary market has none of
 * those. It has two tradeable outcomes and a price. Forcing one into the other
 * would have to invent a creator and a pool, so this borrows the card's visual
 * language instead of its data model.
 */

import Link from "next/link";

export interface MarketCardData {
  id: string;
  symbol: string;
  question: string;
  asset: string;
  status: string;
  expiry: number;
  /** Last traded YES price in [0,1], or null when nothing has traded yet. */
  lastPrice: number | null;
  volume: number;
  tradeCount: number;
}

/** Short, stable label for a market, the way the arena badges an id. */
function marketCode(symbol: string): string {
  const head = symbol.split("/")[0] ?? symbol;
  return head.length > 18 ? `${head.slice(0, 18)}…` : head;
}

function timeLeft(expiry: number, now: number): { label: string; expired: boolean } {
  const seconds = expiry - now;
  if (seconds <= 0) return { label: "settling", expired: true };
  if (seconds < 3_600) return { label: `${Math.max(1, Math.round(seconds / 60))}m left`, expired: false };
  if (seconds < 86_400) return { label: `${Math.round(seconds / 3_600)}h left`, expired: false };
  return { label: `${Math.round(seconds / 86_400)}d left`, expired: false };
}

export default function MarketCard({ market, now }: { market: MarketCardData; now: number }) {
  const { label: remaining, expired } = timeLeft(market.expiry, now);
  // The venue keeps calling an expired market "Trading" until it settles, so the
  // clock is the honest signal here, not the status field.
  const live = market.status === "Trading" && !expired;

  const yes = market.lastPrice === null ? null : Math.round(market.lastPrice * 1000) / 10;
  const statusPillClass = live
    ? "font-display text-xs font-semibold uppercase tracking-wide text-pv-emerald bg-pv-emerald/10 px-2 py-1"
    : "font-display text-xs font-semibold uppercase tracking-wide text-pv-muted bg-pv-ink/[0.06] px-2 py-1 ring-1 ring-pv-ink/[0.08]";

  return (
    <article className="card group relative flex h-full flex-col gap-6 overflow-hidden border-pv-ink/[0.12] bg-pv-surface p-6 transition-all duration-300 hover:border-pv-emerald/30 hover:bg-pv-surface2 sm:gap-8 sm:p-8">
      <div className="relative z-10 flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className={statusPillClass}>{live ? "trading" : remaining}</span>
          <span className="font-display text-xs font-semibold uppercase tracking-wide text-pv-muted bg-pv-ink/[0.06] px-2 py-1 ring-1 ring-pv-ink/[0.08]">
            binary
          </span>
        </div>
        <span className="rounded px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-pv-muted ring-1 ring-pv-ink/[0.1] bg-pv-ink/[0.03] backdrop-blur-sm">
          {marketCode(market.symbol)}
        </span>
      </div>

      <div className="relative z-10 min-w-0 flex-1">
        <h3 className="line-clamp-2 font-display text-xl font-bold uppercase leading-tight tracking-tight text-pv-text sm:text-2xl">
          {market.question || market.symbol}
        </h3>
        <p className="mt-3 text-left text-[11px] font-display font-bold uppercase tracking-[0.12em] text-pv-muted sm:text-xs">
          {market.asset} · {live ? remaining : "closed"}
        </p>
      </div>

      {/* The price is the card's point: it is the crowd's answer to the question
          above, and the only number a reader needs to disagree with. */}
      <div className="relative z-10 grid grid-cols-2 gap-px overflow-hidden rounded border border-pv-ink/[0.1] bg-pv-ink/[0.08]">
        <div className="bg-pv-surface px-3 py-3 text-center">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-pv-muted">yes</p>
          <p className="mt-1 font-display text-lg font-bold tabular-nums text-pv-emerald">
            {yes === null ? "—" : `${yes.toFixed(1)}%`}
          </p>
        </div>
        <div className="bg-pv-surface px-3 py-3 text-center">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-pv-muted">no</p>
          <p className="mt-1 font-display text-lg font-bold tabular-nums text-pv-gold">
            {yes === null ? "—" : `${(100 - yes).toFixed(1)}%`}
          </p>
        </div>
      </div>

      <div className="relative z-10 flex items-center justify-between gap-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-pv-muted">
          {market.volume.toFixed(2)} vol · {market.tradeCount} trades
        </p>
        <Link
          href={`/explorer/${encodeURIComponent(market.id)}`}
          className="btn-compact-primary px-4 py-2 text-sm"
        >
          {live ? "Trade" : "View"}
        </Link>
      </div>
    </article>
  );
}
