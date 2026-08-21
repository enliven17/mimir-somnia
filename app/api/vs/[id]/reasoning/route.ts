/**
 * GET /api/vs/[id]/reasoning — the public agent reasoning timeline for a claim.
 *
 * Free and public: the summary, position, confidence, uncertainty and evidence
 * references. The x402 premium tier sells the persona's full take
 * (/api/council/reasoning), not this feed.
 *
 * Withheld and tombstoned events are excluded by the query, so an event that
 * tripped the safety pass never reaches a reader — while remaining in the table
 * as the audit trail.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getReasoningFeed } from "@/lib/db";
import { isReasoningStage, type EvidenceRef } from "@/lib/reasoning/schema";

export const dynamic = "force-dynamic";

interface FeedItem {
  eventId: string;
  agentId: string;
  track: string;
  stage: string;
  position: string;
  confidenceBps: number;
  summary: string;
  uncertainty: string;
  evidence: Array<{
    domain: string;
    url: string;
    capturedAt: number;
    contentHash: string;
    freshnessSeconds?: number;
    trustTier?: string;
  }>;
  model?: string;
  promptVersion?: number;
  /** True when this was published before the agent took a position with money. */
  beforeStake: boolean;
  createdAt: number;
}

function parseEvidence(json: string): EvidenceRef[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as EvidenceRef[]) : [];
  } catch {
    return [];
  }
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  const claimId = Number(id);
  if (!Number.isInteger(claimId) || claimId < 1) {
    return NextResponse.json({ error: "invalid claim id" }, { status: 400 });
  }

  const { searchParams } = req.nextUrl;
  const track = searchParams.get("track")?.trim() || undefined;
  const agentId = searchParams.get("agent")?.trim() || undefined;
  const stageParam = searchParams.get("stage")?.trim();
  const stage = stageParam && isReasoningStage(stageParam) ? stageParam : undefined;

  try {
    const rows = await getReasoningFeed({ claimId, track, agentId, stage });
    const items: FeedItem[] = rows.map((row) => ({
      eventId: row.event_id,
      agentId: row.agent_id,
      track: row.track,
      stage: row.stage,
      position: row.position,
      confidenceBps: row.confidence_bps,
      summary: row.summary,
      uncertainty: row.uncertainty,
      evidence: parseEvidence(row.evidence_refs_json).map((ref) => ({
        domain: ref.domain,
        url: ref.url,
        capturedAt: ref.capturedAt,
        contentHash: ref.contentHash,
        freshnessSeconds: ref.freshnessSeconds,
        trustTier: ref.trustTier,
      })),
      model: row.model ?? undefined,
      promptVersion: row.prompt_version ?? undefined,
      // Lets the UI separate "explained itself first" from "explained itself
      // after committing money" without the client knowing the stage taxonomy.
      beforeStake: row.stage === "preflight" || row.stage === "pre_stake",
      createdAt: row.created_at,
    }));

    return NextResponse.json(
      { claimId, count: items.length, items },
      {
        headers: {
          // The feed grows slowly and is polled by the detail page.
          "cache-control": "s-maxage=15, stale-while-revalidate=60",
        },
      },
    );
  } catch (err) {
    // No Neon configured (or it is down) means no feed — not a broken page.
    const message = err instanceof Error ? err.message : "read failed";
    return NextResponse.json({ claimId, count: 0, items: [], error: message }, { status: 503 });
  }
}
