/**
 * What the council actually bought on one DreamDEX market.
 *
 * The venue is a settlement layer: an order book knows a fill happened and at
 * what price, and nothing about why. The reasoning only exists in the worker
 * that placed the order, which is why these rows come from `venue_positions`
 * rather than the chain — and why a market page without this panel shows a
 * price with no argument behind it.
 *
 * This is the DreamDEX counterpart of ReasoningFeed on a VS claim: same job —
 * show the agent, the side, the size and the sentence — different source,
 * because a binary market has no claim id to fetch a feed for.
 */

import { getCouncilPersonaIndex } from "@/lib/council-resolver";
import { openPeepsAvatar } from "@/lib/avatars";
import { getExplorerTxUrl } from "@/lib/chain";
import type { VenuePositionRow } from "@/lib/db";

function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash;
}

function ago(createdAt: number, now: number): string {
  const seconds = Math.max(0, Math.round(now / 1000 - createdAt));
  if (seconds < 90) return "just now";
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

export default function CouncilMarketBets({
  positions,
}: {
  positions: VenuePositionRow[];
}) {
  const personas = getCouncilPersonaIndex();
  const now = Date.now();

  const yes = positions.filter((p) => p.outcome === "YES");
  const staked = positions.reduce((sum, p) => sum + p.stakeUsdc, 0);

  return (
    <section className="card border-pv-ink/[0.12] bg-pv-surface p-5 sm:p-6">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="font-display text-sm font-bold uppercase tracking-[0.14em] text-pv-text">
          Council positions
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-pv-muted">
          {positions.length} fill{positions.length === 1 ? "" : "s"}
        </span>
      </div>

      {positions.length === 0 ? (
        <p className="text-sm leading-relaxed text-pv-muted">
          No council agent has taken a side here yet. Personas only buy when a
          market clears their category filter and their edge beats the ask.
        </p>
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-px overflow-hidden rounded border border-pv-ink/[0.1] bg-pv-ink/[0.08]">
            <div className="bg-pv-surface px-3 py-3 text-center">
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-pv-muted">
                staked
              </p>
              <p className="mt-1 font-display text-lg font-bold tabular-nums text-pv-text">
                {staked.toFixed(2)}
              </p>
            </div>
            <div className="bg-pv-surface px-3 py-3 text-center">
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-pv-muted">
                yes / no
              </p>
              <p className="mt-1 font-display text-lg font-bold tabular-nums text-pv-text">
                <span className="text-pv-emerald">{yes.length}</span>
                <span className="text-pv-muted"> / </span>
                <span className="text-pv-gold">{positions.length - yes.length}</span>
              </p>
            </div>
          </div>

          <ol className="flex flex-col gap-4">
            {positions.map((position) => {
              const persona = personas.get(position.agentId);
              const isYes = position.outcome === "YES";
              return (
                <li
                  key={position.txHash}
                  className="rounded-xl border border-pv-ink/[0.1] bg-pv-surface2/60 p-4"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-pv-ink/[0.15] bg-pv-surface">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={openPeepsAvatar(`council-${position.agentId}`)}
                        alt=""
                        className="h-full w-full object-cover object-top opacity-95"
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-display text-sm font-bold text-pv-text">
                        {persona ? `${persona.emoji} ${persona.displayName}` : position.agentId}
                      </p>
                      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-pv-muted">
                        {position.track} · {ago(position.createdAt, now)}
                      </p>
                    </div>
                    <span
                      className={`font-display text-xs font-semibold uppercase tracking-wide px-2 py-1 ${
                        isYes
                          ? "text-pv-emerald bg-pv-emerald/10"
                          : "text-pv-gold bg-pv-gold/10"
                      }`}
                    >
                      {position.outcome}
                    </span>
                  </div>

                  {position.rationale ? (
                    <p className="mt-3 text-sm leading-relaxed text-pv-muted">
                      {position.rationale}
                    </p>
                  ) : null}

                  <dl className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] uppercase tracking-[0.14em] text-pv-muted">
                    <div className="flex gap-1">
                      <dt>stake</dt>
                      <dd className="tabular-nums text-pv-text">
                        {position.stakeUsdc.toFixed(2)}
                      </dd>
                    </div>
                    <div className="flex gap-1">
                      <dt>@</dt>
                      <dd className="tabular-nums text-pv-text">
                        {position.price.toFixed(3)}
                      </dd>
                    </div>
                    <div className="flex gap-1">
                      <dt>qty</dt>
                      <dd className="tabular-nums text-pv-text">
                        {position.quantity.toFixed(2)}
                      </dd>
                    </div>
                    {position.confidence > 0 && (
                      <div className="flex gap-1">
                        <dt>conf</dt>
                        <dd className="tabular-nums text-pv-text">{position.confidence}%</dd>
                      </div>
                    )}
                    <a
                      href={getExplorerTxUrl(position.txHash)}
                      target="_blank"
                      rel="noreferrer"
                      className="underline decoration-dotted underline-offset-2 hover:text-pv-text"
                    >
                      {shortHash(position.txHash)}
                    </a>
                  </dl>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}
