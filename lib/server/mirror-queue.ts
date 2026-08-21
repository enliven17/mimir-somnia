/**
 * What a basket subscriber has not mirrored yet.
 *
 * Following a basket records an intent; it cannot move money on its own, because
 * the contract takes the stake from `msg.sender` and Mimir holds no key for the
 * subscriber. Delegated signing is intentionally disabled in this deployment.
 *
 * So the honest middle is this: compute what the subscriber WOULD have mirrored,
 * show it, and let them sign it themselves in one click. No custody, no waiting on
 * infrastructure that is not configured, and the queue is exactly the input the
 * delegated executor will consume once it exists.
 *
 * Positions already taken are excluded, so a mirror is never offered twice and
 * re-following does not duplicate anything.
 */

import "server-only";

import { getChallengersByClaimId, getClaimsByFilter, listBasketSubscriptions } from "@/lib/db";
import { allBasketDefinitions } from "./basket-directory";
import { listDirectoryAgents } from "./agent-directory";

export interface PendingMirror {
  basketId: string;
  basketName: string;
  claimId: number;
  question: string;
  /** The member whose position is being copied. */
  agentId: string;
  agentName: string;
  /** What that member staked, display USDC. */
  memberStakeUsdc: number;
  /** What the subscriber would stake: their per-market cap scaled by weight. */
  mirrorUsdc: number;
  weightBps: number;
  deadline: number;
}

/**
 * Mirrors still open to a subscriber.
 *
 * Weighted, not flat: a member at 10% of a basket should pull 10% of the
 * subscriber's per-market budget, or following a basket would just be following
 * whichever member happened to act first.
 */
export async function pendingMirrorsFor(
  subscriber: string,
  perMarketUsdc: Record<string, number> = {},
): Promise<PendingMirror[]> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(subscriber)) return [];
  const wallet = subscriber.toLowerCase();

  const subscribed = await listBasketSubscriptions(wallet).catch(() => []);
  if (subscribed.length === 0) return [];

  const [definitions, directory, openClaims] = await Promise.all([
    allBasketDefinitions().catch(() => []),
    listDirectoryAgents().catch(() => []),
    getClaimsByFilter({ states: ["open", "active"], orderBy: "deadline_asc", limit: 50 }).catch(() => []),
  ]);
  const agentById = new Map(directory.map((agent) => [agent.id, agent]));
  const nowSeconds = Math.floor(Date.now() / 1000);

  const pending: PendingMirror[] = [];

  for (const basketId of subscribed) {
    const definition = definitions.find((candidate) => candidate.id === basketId);
    if (!definition) continue;
    const budget = perMarketUsdc[basketId] ?? 2;

    for (const claim of openClaims) {
      // No point offering a mirror that cannot be staked before it settles.
      if (claim.deadline <= nowSeconds + 300) continue;
      if (claim.creator.toLowerCase() === wallet) continue;

      const challengers = await getChallengersByClaimId(claim.id).catch(() => []);
      const taken = new Set(challengers.map((c) => c.address.toLowerCase()));
      if (taken.has(wallet)) continue; // already mirrored, or acted independently

      for (const member of definition.members) {
        const agent = agentById.get(member.agentId);
        if (!agent) continue;
        const position = challengers.find((c) => c.address.toLowerCase() === agent.address.toLowerCase());
        if (!position) continue;

        const mirrorUsdc = Math.round((budget * member.weightBps / 10_000) * 100) / 100;
        // Below a cent there is nothing to stake; the contract's minimum would
        // reject it anyway and the row would only be noise.
        if (mirrorUsdc <= 0) continue;

        pending.push({
          basketId, basketName: definition.name,
          claimId: claim.id, question: claim.question ?? `Claim #${claim.id}`,
          agentId: agent.id, agentName: agent.displayName,
          memberStakeUsdc: position.stake, mirrorUsdc,
          weightBps: member.weightBps, deadline: claim.deadline,
        });
        break; // one mirror per claim: the basket takes a side, not several
      }
    }
  }

  return pending.sort((a, b) => a.deadline - b.deadline);
}
