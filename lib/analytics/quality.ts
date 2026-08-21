import { ANALYTICS_EVENTS, type AnalyticsEvent } from "./events";

export interface ExportedAnalyticsEvent {
  event: string;
  distinct_id?: string;
  timestamp?: string;
  properties?: Record<string, unknown>;
}

export interface AnalyticsQualityOptions {
  minimumEvents?: number;
  completenessTarget?: number;
}

export interface AnalyticsQualityReport {
  productEvents: number;
  completeEvents: number;
  completeness: number;
  createStarted: number;
  createConfirmed: number;
  marketViewed: number;
  stakeConfirmed: number;
  createConversion: number;
  stakeConversion: number;
  passed: boolean;
  failures: string[];
}

const PRODUCT_EVENTS = new Set<string>(ANALYTICS_EVENTS);
const MODE_OPTIONAL = new Set<AnalyticsEvent>([
  "agent_viewed", "agent_followed", "agent_unfollowed",
  "copy_permission_created", "copy_revoked",
]);

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function eventIsComplete(row: ExportedAnalyticsEvent): boolean {
  const properties = row.properties ?? {};
  if (!finiteNumber(properties.event_version) || !finiteNumber(properties.chain_id)) return false;
  if (!MODE_OPTIONAL.has(row.event as AnalyticsEvent) && typeof properties.settlement_mode !== "string") return false;
  return true;
}

function count(rows: ExportedAnalyticsEvent[], event: AnalyticsEvent): number {
  return rows.reduce((total, row) => total + Number(row.event === event), 0);
}

export function evaluateAnalyticsQuality(
  input: ExportedAnalyticsEvent[],
  options: AnalyticsQualityOptions = {},
): AnalyticsQualityReport {
  const minimumEvents = options.minimumEvents ?? 100;
  const completenessTarget = options.completenessTarget ?? 0.99;
  const rows = input.filter((row) => PRODUCT_EVENTS.has(row.event) && row.properties?.is_internal !== true);
  const completeEvents = rows.reduce((total, row) => total + Number(eventIsComplete(row)), 0);
  const createStarted = count(rows, "create_started");
  const createConfirmed = count(rows, "create_confirmed");
  const marketViewed = count(rows, "market_viewed");
  const stakeConfirmed = count(rows, "stake_confirmed");
  const completeness = rows.length === 0 ? 0 : completeEvents / rows.length;
  const createConversion = createStarted === 0 ? 0 : createConfirmed / createStarted;
  const stakeConversion = marketViewed === 0 ? 0 : stakeConfirmed / marketViewed;
  const failures: string[] = [];

  if (rows.length < minimumEvents) failures.push(`need at least ${minimumEvents} product events; found ${rows.length}`);
  if (completeness < completenessTarget) failures.push(`envelope completeness ${(completeness * 100).toFixed(2)}% is below ${(completenessTarget * 100).toFixed(2)}%`);
  if (createStarted === 0 || createConfirmed === 0) failures.push("create funnel has no measurable start/confirmation pair");
  if (marketViewed === 0 || stakeConfirmed === 0) failures.push("stake funnel has no measurable view/confirmation pair");
  if (createConfirmed > createStarted) failures.push("create confirmations exceed starts; inspect attribution or deduplication");
  if (stakeConfirmed > marketViewed) failures.push("stake confirmations exceed views; inspect attribution or deduplication");

  return { productEvents: rows.length, completeEvents, completeness, createStarted, createConfirmed,
    marketViewed, stakeConfirmed, createConversion, stakeConversion, passed: failures.length === 0, failures };
}
