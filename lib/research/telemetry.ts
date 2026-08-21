import type { CategoryRejection } from "./categories";
import type { FetchFailure } from "./gateway";

export interface ResearchMetricsSnapshot {
  coverage: Record<string, number>;
  rejects: Partial<Record<CategoryRejection, number>>;
  sourceFailures: Record<string, number>;
  settlementAmbiguity: Record<string, number>;
}
const state: ResearchMetricsSnapshot = { coverage: {}, rejects: {}, sourceFailures: {}, settlementAmbiguity: {} };
function increment(target: Record<string, number>, key: string): void { target[key] = (target[key] ?? 0) + 1; }
export function recordCategoryCoverage(category: string): void { increment(state.coverage, category.trim().toLowerCase()); }
export function recordCategoryReject(reason: CategoryRejection): void { increment(state.rejects as Record<string, number>, reason); }
export function recordSourceFailure(failure: FetchFailure["kind"]): void { increment(state.sourceFailures, failure); }
export function recordSettlementAmbiguity(category: string): void { increment(state.settlementAmbiguity, category.trim().toLowerCase()); }
export function researchMetricsSnapshot(): ResearchMetricsSnapshot { return structuredClone(state); }
export function resetResearchMetrics(): void { for (const group of Object.values(state)) for (const key of Object.keys(group)) delete group[key]; }
