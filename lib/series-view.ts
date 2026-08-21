/**
 * Turning a rematch chain into rows the VS page can render.
 *
 * `lib/series.ts` does the derivation; this adapts it to `VSData`, the shape the
 * page already holds, and answers the two questions the card asks: what round is
 * this, and what is the score.
 *
 * Why an adapter instead of calling buildSeries from the component: the round
 * number is NOT the array index. The chain arrives in fetch order, and a series
 * with a missing middle round — an ancestor outside the read-index window — would
 * renumber every later round if the index were used. Getting that wrong shows a
 * user "round 2" on a market the other side remembers as round 4.
 */

import type { VSData } from "@/lib/contract";

import { buildSeries, type SeriesClaim, type SeriesWinner } from "@/lib/series";

export interface SeriesViewRow {
  claim: VSData;
  /** Round number within the series, derived from the parent chain. */
  round: number;
  winner: SeriesWinner;
  /** Settled without picking a side: draw, unresolvable, or cancelled. */
  refunded: boolean;
  decided: boolean;
  isCurrent: boolean;
}

export interface SeriesView {
  rows: SeriesViewRow[];
  creatorWins: number;
  challengerWins: number;
  refundedRounds: number;
  /** e.g. "2-1". Null when nothing has been decided yet. */
  scoreLabel: string | null;
  /** Who is ahead, or "none" when level or undecided. */
  leader: SeriesWinner;
  nextRound: number;
  /** True when a malformed parent chain was detected, so the UI can stay quiet. */
  cycleDetected: boolean;
  branched: boolean;
  /** Parallel rematches off this line. Counted so the UI can say so, never scored. */
  branchCount: number;
}

/**
 * VSData calls an active market "accepted"; the series module calls it "active".
 * Mapping here rather than widening SeriesClaim keeps the chain vocabulary from
 * leaking a UI-layer name into the derivation.
 */
function toSeriesClaim(claim: VSData): SeriesClaim {
  return {
    id: claim.id,
    parentId: claim.parent_id ?? 0,
    state: claim.state === "accepted" ? "active" : claim.state,
    winnerSide: claim.winner_side ?? "",
    createdAt: claim.created_at,
  };
}

export function buildSeriesView(currentId: number, chain: VSData[]): SeriesView {
  const byId = new Map(chain.map((claim) => [claim.id, claim]));
  const series = buildSeries(currentId, chain.map(toSeriesClaim));

  const rows: SeriesViewRow[] = [];
  for (const round of series.rounds) {
    const claim = byId.get(round.claimId);
    // A round whose claim is not in the window is skipped rather than rendered as
    // a placeholder — but its round NUMBER is preserved for the rounds around it,
    // which is the whole reason the index is not used as the round.
    if (!claim) continue;
    rows.push({
      claim,
      round: round.round,
      winner: round.winner,
      refunded: round.refunded,
      decided: round.decided,
      isCurrent: claim.id === currentId,
    });
  }

  const decided = series.creatorWins + series.challengerWins > 0;
  return {
    rows,
    creatorWins: series.creatorWins,
    challengerWins: series.challengerWins,
    refundedRounds: series.refundedRounds,
    scoreLabel: decided ? `${series.creatorWins}-${series.challengerWins}` : null,
    leader:
      series.creatorWins > series.challengerWins
        ? "creator"
        : series.challengerWins > series.creatorWins
          ? "challengers"
          : "none",
    nextRound: series.nextRound,
    cycleDetected: series.cycleDetected,
    branched: series.branchedAt.length > 0,
    branchCount: series.branchRounds.length,
  };
}

/**
 * Is this chain worth rendering as a series?
 *
 * A single market is a market, not a rivalry. One round with a score of 0-0 would
 * add a card that says nothing.
 */
export function hasSeries(view: SeriesView): boolean {
  return view.rows.length > 1;
}
