/**
 * Grouping the reasoning feed for display.
 *
 * The API returns a flat, chronological list. §03 asks the UI for three things it
 * cannot get from that list directly: a before-stake / after-stake split, agent
 * and track filters, and evidence freshness a reader can judge.
 *
 * Pure so the ordering and the filter semantics are tested rather than eyeballed.
 * The one rule worth stating: **an event with no evidence is still shown.** A
 * feed that hid unsourced reasoning would look uniformly well-sourced, which is
 * the opposite of what a reader needs to know.
 */

export interface FeedEvidence {
  domain: string;
  url: string;
  capturedAt: number;
  contentHash: string;
  freshnessSeconds?: number;
  trustTier?: string;
}

export interface FeedItem {
  eventId: string;
  agentId: string;
  track: string;
  stage: string;
  position: string;
  confidenceBps: number;
  summary: string;
  uncertainty: string;
  evidence: FeedEvidence[];
  model?: string;
  promptVersion?: number;
  beforeStake: boolean;
  createdAt: number;
}

export interface FeedFilter {
  agentId?: string;
  track?: string;
  /** "before" and "after" refer to the agent committing money, not to settlement. */
  phase?: "before" | "after";
}

export interface FeedGroup {
  phase: "before" | "after";
  items: FeedItem[];
}

export interface FeedView {
  groups: FeedGroup[];
  /** Every agent that appears, for the filter control. */
  agents: string[];
  tracks: string[];
  total: number;
  /** Shown so a reader can see how much of the feed is unsourced. */
  withoutEvidence: number;
}

/** Oldest first, then by id so two events in the same second do not flicker. */
export function compareFeedItems(a: FeedItem, b: FeedItem): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.eventId.localeCompare(b.eventId);
}

export function filterFeed(items: FeedItem[], filter: FeedFilter = {}): FeedItem[] {
  const agentId = filter.agentId?.trim().toLowerCase();
  const track = filter.track?.trim().toLowerCase();
  return items.filter((item) => {
    if (agentId && item.agentId.toLowerCase() !== agentId) return false;
    if (track && item.track.toLowerCase() !== track) return false;
    if (filter.phase === "before" && !item.beforeStake) return false;
    if (filter.phase === "after" && item.beforeStake) return false;
    return true;
  });
}

export function buildFeedView(items: FeedItem[], filter: FeedFilter = {}): FeedView {
  const filtered = [...filterFeed(items, filter)].sort(compareFeedItems);
  const before = filtered.filter((item) => item.beforeStake);
  const after = filtered.filter((item) => !item.beforeStake);

  const groups: FeedGroup[] = [];
  // Before-stake first: "said this, then put money on it" is the order that lets a
  // reader judge whether the reasoning followed the position or led it.
  if (before.length > 0) groups.push({ phase: "before", items: before });
  if (after.length > 0) groups.push({ phase: "after", items: after });

  // Filter options come from the UNFILTERED list, so selecting an agent does not
  // remove every other agent from the control that selected it.
  return {
    groups,
    agents: unique(items.map((item) => item.agentId)),
    tracks: unique(items.map((item) => item.track)),
    total: filtered.length,
    withoutEvidence: filtered.filter((item) => item.evidence.length === 0).length,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))].sort();
}

/** Confidence as whole percent. Basis points are an accounting unit, not a label. */
export function confidencePercent(confidenceBps: number): number {
  return Math.round(confidenceBps / 100);
}

/**
 * Human freshness for an evidence reference.
 *
 * Returns null when the age is unknown rather than guessing zero: "captured just
 * now" on evidence of unknown age is a lie a reader would act on.
 */
export function freshnessLabel(
  evidence: Pick<FeedEvidence, "capturedAt" | "freshnessSeconds">,
  nowMs: number,
): { unit: "seconds" | "minutes" | "hours" | "days"; value: number } | null {
  const seconds =
    evidence.freshnessSeconds ??
    (evidence.capturedAt > 0 ? Math.floor((nowMs - evidence.capturedAt) / 1000) : null);
  if (seconds === null || !Number.isFinite(seconds)) return null;
  const clamped = Math.max(0, seconds);
  if (clamped < 60) return { unit: "seconds", value: clamped };
  if (clamped < 3_600) return { unit: "minutes", value: Math.floor(clamped / 60) };
  if (clamped < 86_400) return { unit: "hours", value: Math.floor(clamped / 3_600) };
  return { unit: "days", value: Math.floor(clamped / 86_400) };
}

/** Short content hash for display. The full hash stays in the API response. */
export function shortHash(contentHash: string): string {
  const hex = contentHash.startsWith("0x") ? contentHash.slice(2) : contentHash;
  return hex.length <= 12 ? hex : `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}
