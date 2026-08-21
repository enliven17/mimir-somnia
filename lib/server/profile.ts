/**
 * Whoever is behind an address.
 *
 * Every address on Mimir is one of three things and the page has to say which:
 * an agent's own wallet, the wallet of someone who owns agents, or a person
 * trading for themselves. They are not exclusive — an owner trades too — so this
 * resolves all of it at once rather than making the caller guess.
 *
 * Addresses used to link straight to the block explorer, which answers "what
 * transactions has this address sent" when the question on a market page is
 * "who is this, and are they any good".
 */

import "server-only";

import {
  computeAgentPerformance, windowSinceMs,
  type AgentPerformance, type AgentTradeResult, type TimeWindow,
} from "@/lib/agents/performance";
import { getAgentTradeRows, listAgentRecords } from "@/lib/db";
import { listDirectoryAgents, type DirectoryAgent } from "./agent-directory";

export interface OwnedAgentView extends DirectoryAgent {
  performance: AgentPerformance;
}

export interface ProfileView {
  address: `0x${string}`;
  /** Set when this address IS an agent rather than a person. */
  agent: DirectoryAgent | null;
  /** Agents registered to this address as owner. */
  ownedAgents: OwnedAgentView[];
  /** This address's own trading, whether it is a person or an agent. */
  performance: AgentPerformance;
  results: AgentTradeResult[];
  /** Everything the owned agents realised, summed. */
  agentsRealisedPnlAtomic: bigint;
  agentsSettled: number;
}

export async function buildProfile(
  rawAddress: string, window: TimeWindow = "all", nowMs = Date.now(),
): Promise<ProfileView | null> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(rawAddress)) return null;
  const address = rawAddress.toLowerCase() as `0x${string}`;
  const sinceMs = windowSinceMs(window, nowMs);

  const [directory, records, ownRows] = await Promise.all([
    listDirectoryAgents().catch(() => []),
    listAgentRecords(200).catch(() => []),
    getAgentTradeRows(address).catch(() => []),
  ]);

  const agent = directory.find((candidate) => candidate.address.toLowerCase() === address) ?? null;

  // An owner's agents operate from their own wallets, so their P&L is looked up
  // per agent rather than rolled into the owner's own trading.
  const owned = directory.filter((candidate) => {
    const record = records.find((r) => r.agentId === candidate.id);
    return record?.ownerWallet?.toLowerCase() === address;
  });
  const ownedRows = await Promise.all(
    owned.map((candidate) => getAgentTradeRows(candidate.address).catch(() => [])),
  );

  let agentsRealisedPnlAtomic = 0n;
  let agentsSettled = 0;
  const ownedAgents: OwnedAgentView[] = owned.map((candidate, index) => {
    const { performance } = computeAgentPerformance(ownedRows[index], { sinceMs });
    agentsRealisedPnlAtomic += performance.realisedPnlAtomic;
    agentsSettled += performance.settled;
    return { ...candidate, performance };
  });

  const { performance, results } = computeAgentPerformance(ownRows, { sinceMs });

  return {
    address,
    agent,
    ownedAgents,
    performance,
    results: results.sort((a, b) => b.claimId - a.claimId),
    agentsRealisedPnlAtomic,
    agentsSettled,
  };
}

/** Owner wallet for an agent id, for the "created by" line on an agent page. */
export async function findAgentOwner(agentId: string): Promise<string | null> {
  const records = await listAgentRecords(200).catch(() => []);
  return records.find((record) => record.agentId === agentId)?.ownerWallet ?? null;
}
