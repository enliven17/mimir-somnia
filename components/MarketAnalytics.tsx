"use client";

/**
 * Renders nothing; exists only to hold the market funnel hooks.
 *
 * The VS page returns early while loading and when a claim is missing, so the
 * hooks cannot live in that component — they would be called conditionally and
 * React would throw "rendered more hooks than during the previous render" on the
 * transition from loading to loaded. Inside a child that mounts only in the
 * loaded branch, the same hooks are unconditional.
 */

import {
  useMarketViewed,
  useSettlementReturnViewed,
  useShareAttribution,
  useStakePreviewTracking,
  type StakePreviewSignal,
} from "@/lib/analytics/useMarketAnalytics";
import type { CanonicalMode } from "@/lib/market-modes";
import type { SourceSurface } from "@/lib/analytics/events";

export function MarketAnalytics({
  claimId,
  mode,
  category,
  address,
  surface,
  preview,
  settlementReturn,
}: {
  claimId: number;
  mode: CanonicalMode;
  category?: string;
  address?: string | null;
  surface?: SourceSurface;
  preview: StakePreviewSignal | null;
  settlementReturn?: { resolved: boolean; isParticipant: boolean } | null;
}) {
  const context = { claimId, mode, category, address, surface };
  useMarketViewed(context);
  useShareAttribution(context);
  useStakePreviewTracking(context, preview);
  useSettlementReturnViewed(context, settlementReturn ?? null);
  return null;
}
