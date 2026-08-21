/**
 * Product analytics definitions kept in version control.
 *
 * PostHog is a projection of these definitions, never a financial source of
 * truth. Keeping the event order, conversion windows, exclusions and breakdowns
 * here makes a dashboard reproducible after a project reset and reviewable like
 * application code.
 */

import type { AnalyticsEvent } from "./events";

export interface FunnelDefinition {
  id: string;
  name: string;
  events: readonly AnalyticsEvent[];
  conversionWindowDays: number;
  breakdowns: readonly ("settlement_mode" | "category" | "actor_type")[];
  excludeInternal: boolean;
}

export interface DashboardDefinition {
  id: string;
  name: string;
  funnelIds: readonly string[];
  breakdowns: readonly ("settlement_mode" | "category" | "actor_type")[];
  retention: readonly {
    name: string;
    returningEvent: AnalyticsEvent;
    period: "day" | "week" | "month";
  }[];
}

export interface MetricDefinition {
  id: string;
  name: string;
  source: "posthog" | "onchain_ledger" | "read_index" | "operational";
  numerator: string;
  denominator?: string;
  breakdowns: readonly string[];
}

export const PRODUCT_FUNNELS = [
  {
    id: "create",
    name: "Create → confirmed",
    events: ["create_started", "create_submitted", "create_confirmed"],
    conversionWindowDays: 1,
    breakdowns: ["settlement_mode", "category", "actor_type"],
    excludeInternal: true,
  },
  {
    id: "stake",
    name: "Market view → stake confirmed",
    events: ["market_viewed", "stake_started", "stake_confirmed"],
    conversionWindowDays: 7,
    breakdowns: ["settlement_mode", "category", "actor_type"],
    excludeInternal: true,
  },
  {
    id: "settlement-return",
    name: "Stake → settlement return",
    events: ["stake_confirmed", "settlement_return_viewed"],
    conversionWindowDays: 30,
    breakdowns: ["settlement_mode", "category", "actor_type"],
    excludeInternal: true,
  },
  {
    id: "follow-to-copy",
    name: "Follow → copy execution",
    events: ["agent_followed", "copy_permission_created", "copy_executed"],
    conversionWindowDays: 30,
    breakdowns: ["category", "actor_type"],
    excludeInternal: true,
  },
  {
    id: "share-to-market",
    name: "Shared visit → market view → stake",
    events: ["share_card_clicked", "market_viewed", "stake_confirmed"],
    conversionWindowDays: 7,
    breakdowns: ["settlement_mode", "category", "actor_type"],
    excludeInternal: true,
  },
] as const satisfies readonly FunnelDefinition[];

export const PRODUCT_DASHBOARDS = [
  {
    id: "conversion",
    name: "Mimir conversion",
    funnelIds: ["create", "stake", "settlement-return", "follow-to-copy", "share-to-market"],
    breakdowns: ["settlement_mode", "category", "actor_type"],
    retention: [],
  },
  {
    id: "retention",
    name: "Mimir retention",
    funnelIds: ["create", "stake"],
    breakdowns: ["settlement_mode", "category", "actor_type"],
    retention: [
      { name: "D1 creator", returningEvent: "create_started", period: "day" },
      { name: "D7 challenger", returningEvent: "market_viewed", period: "week" },
      { name: "D30 agent owner", returningEvent: "agent_viewed", period: "month" },
    ],
  },
] as const satisfies readonly DashboardDefinition[];

/** Roadmap §15, executable ownership map: money never comes from PostHog. */
export const SUCCESS_METRICS = [
  { id: "view_to_stake", name: "Market view → stake conversion", source: "posthog", numerator: "stake_confirmed", denominator: "market_viewed", breakdowns: ["settlement_mode"] },
  { id: "create_to_confirmed", name: "Create start → confirmed", source: "posthog", numerator: "create_confirmed", denominator: "create_started", breakdowns: ["settlement_mode", "category"] },
  { id: "actor_retention", name: "D1/D7/D30 retention", source: "posthog", numerator: "returning actor", denominator: "first active actor", breakdowns: ["creator", "challenger", "agent_owner"] },
  { id: "rematch_series", name: "Rematch and series completion", source: "read_index", numerator: "settled rematches and completed series", denominator: "eligible settlements", breakdowns: ["best_of"] },
  { id: "reasoning_to_stake", name: "Reasoning open/purchase → stake", source: "posthog", numerator: "stake_confirmed", denominator: "reasoning_opened or reasoning_x402_purchased", breakdowns: ["track"] },
  { id: "share_attribution", name: "Share → qualified view → stake", source: "posthog", numerator: "stake_confirmed", denominator: "share_card_clicked", breakdowns: ["network", "settlement_mode"] },
  { id: "automated_market_quality", name: "Proposal acceptance, ambiguity, reject and source failure", source: "operational", numerator: "accepted/rejected/ambiguous/failed proposals", denominator: "all proposals", breakdowns: ["category", "settlement_mode"] },
  { id: "byoa_activation", name: "Registered → active → revenue earning agent", source: "read_index", numerator: "agents with actions/revenue", denominator: "registered agents", breakdowns: ["authority_level", "capability"] },
  { id: "copy_quality", name: "Copy outcomes, realized PnL and revokes", source: "onchain_ledger", numerator: "executed/skipped/failed/revoked", denominator: "copy attempts and permissions", breakdowns: ["signal_agent", "execution_agent"] },
  { id: "revenue", name: "Platform, owner and x402 revenue", source: "onchain_ledger", numerator: "atomic fee accruals and settled x402 payments", breakdowns: ["revenue_source"] },
  { id: "operations", name: "Resolution latency, worker health and index freshness", source: "operational", numerator: "health samples and latency buckets", breakdowns: ["worker", "dependency"] },
] as const satisfies readonly MetricDefinition[];

export function analyticsDefinitionErrors(): string[] {
  const errors: string[] = [];
  const funnelIds = new Set(PRODUCT_FUNNELS.map((funnel) => funnel.id));
  for (const dashboard of PRODUCT_DASHBOARDS) {
    for (const id of dashboard.funnelIds) {
      if (!funnelIds.has(id)) errors.push(`${dashboard.id}: unknown funnel '${id}'`);
    }
  }
  const metricIds = new Set<string>();
  for (const metric of SUCCESS_METRICS) {
    if (metricIds.has(metric.id)) errors.push(`duplicate metric '${metric.id}'`);
    metricIds.add(metric.id);
    if (metric.source === "posthog" && /revenue|fee|pnl/i.test(metric.numerator)) {
      errors.push(`${metric.id}: financial truth cannot come from PostHog`);
    }
  }
  return errors;
}
