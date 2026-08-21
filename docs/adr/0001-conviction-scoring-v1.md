# ADR 0001 — Conviction scoring v1

- **Status:** accepted
- **Date:** 2026-08-11
- **Version constant:** `CONVICTION_VERSION = 1` (`lib/scoring.ts`)
- **Scope:** off-chain ranking only. Nothing here moves money or affects a payout.

## Decision

A settled position scores:

```
score = correctness × stakeFactor × timeFactor × underdogFactor
```

and an actor is **ranked by the mean score per scored position**, not by the sum.

| Factor | Range | Definition |
| --- | --- | --- |
| `correctness` | −1, 0, +1 | +1 win, −1 loss, 0 refund or pending |
| `stakeFactor` | 0…1 | `log10(1 + min(stake, 100)) / log10(101)` |
| `timeFactor` | 0…1 | `1 − elapsed / window`, clamped; 0 at or past the deadline |
| `underdogFactor` | 1…2 | `1 + (5000 − min(sideShareBps, 5000)) / 5000` |

Ranking requires **3 decisive results**. Actors below that are returned as
`unranked` rather than dropped.

## Why each part is shaped this way

**Stake is logarithmic and capped at 100 USDC.** Linear stake weight makes the
leaderboard a ranking of wallet sizes. The cap means the 101st USDC buys nothing,
so being rich is not a forecasting skill.

**Timing is symmetric.** Lateness reduces a win *and* softens a loss. If it only
reduced gains, entering late would be a free option: wait until the outcome is
obvious, take the near-certain side, collect a small score with no downside. An
early loss costs more than a late one, which is the point.

**The underdog factor reads the actor's share of its OWN side**, not the market's
overall imbalance. It is a scoring weight for taking a position that was not
already priced in — never a claim about the chance of winning. A market where the
side you cannot join is thin gets no credit.

**Refunds score zero and are excluded from every rate.** A draw, an unresolvable
outcome or a cancellation returns every stake. Scoring one as a loss punishes a
user for an ambiguity that was not their doing; scoring it as a win invents a
result. A refund also does not break a streak — a user who staked, drew, and
staked again has not stopped being right.

**Ranking on the mean, not the total.** This is a correction, not the original
design. Per-position scores are capped at 1 but a sum has no ceiling, so winning
a hundred 0.50 USDC markets outscored winning three considered ones. The total is
still reported for display; the mean plus the qualifying floor is what ranks. The
floor is what stops the opposite failure — one lucky win at 100%.

## What is deliberately NOT in the score

- **Evidence quality and self-reported confidence.** Both are subjective inputs
  an actor controls. They are displayed next to a record, never folded into it,
  until there is a way to verify them that the actor cannot author.
- **Realized PnL.** Reported alongside, never mixed in. One is a money number and
  the other is a ranking weight; combining them makes a large wallet look like a
  better forecaster. A win with no known payout adds zero profit rather than a
  guess, because guessing from the pool prints a number the escrow never paid.
- **Volume.** Visible as `resolvedCount`, but not a multiplier. See the mean
  decision above.

## Anti-gaming properties, each with a test

`tests/node/conviction-gaming.test.ts`

| Attack | Why it fails |
| --- | --- |
| Micro-stake spam | Ranking on the mean; dust stake earns a near-zero factor |
| Buying rank | `stakeFactor` capped at 100 USDC and log-scaled |
| Sybil splitting | Scores never pool across addresses, and each wallet must clear the qualifying floor on its own |
| Late entry | `timeFactor` → 0 near the deadline, and lateness softens losses too |
| Self-created market | Both sides dropped when the creator is also a challenger, counted as `selfDealtClaims` |

## Consequences

- The leaderboard is a **projection**, rebuildable from chain events; no score is
  stored. `tests/node/leaderboard-rebuild.test.ts` proves a streak survives a
  reorg and resync unchanged. A stored score would be a second source of truth
  able to drift from the escrow it describes.
- Agents and humans rank in separate tables. An agent staking hourly out-volumes
  any person, so one merged table is just a list of agents.
- Changing any factor requires bumping `CONVICTION_VERSION`, so two records
  computed under different rules are distinguishable rather than silently
  comparable.

## Alternatives rejected

- **Brier / log score on stated probabilities.** Better statistics, but it ranks
  self-reported numbers rather than positions taken with money, and an actor can
  state a probability it does not act on. Revisit if stated probabilities become
  a first-class, staked artefact.
- **Elo between opponents.** Fits duels, not pool markets with many challengers
  on one side.
- **Money-weighted returns.** Already available as realized PnL, and as a
  *ranking* it just re-sorts by wallet size.
