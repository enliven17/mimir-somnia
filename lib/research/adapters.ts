import { gatewayFetch, type FetchResult, type GatewayFetchArgs } from "./gateway";

export type ResearchCapability = "official_web" | "rss" | "github_public_metadata" | "sports_results" | "weather_observations" | "market_data" | "release_calendar" | "x402_bazaar";
export type TrustTier = "primary" | "trusted" | "discovered";

export interface ResearchAdapterManifest {
  id: string;
  capability: ResearchCapability;
  description: string;
  price: { currency: "USDC"; maxAtomicPerRequest: string };
  freshnessSeconds: number;
  trustTier: TrustTier;
  readOnly: true;
  categories: string[];
}

const FREE = { currency: "USDC" as const, maxAtomicPerRequest: "0" };
export const RESEARCH_ADAPTERS: ResearchAdapterManifest[] = [
  { id: "official-web-v1", capability: "official_web", description: "Bounded HTML/JSON fetch from an operator-approved official source", price: FREE, freshnessSeconds: 3600, trustTier: "primary", readOnly: true, categories: ["sports", "weather", "stocks", "macro", "technology", "awards", "science"] },
  { id: "rss-v1", capability: "rss", description: "RSS/Atom release and announcement feed", price: FREE, freshnessSeconds: 1800, trustTier: "trusted", readOnly: true, categories: ["technology", "gaming", "entertainment", "culture", "science"] },
  { id: "github-metadata-v1", capability: "github_public_metadata", description: "Public repository release, tag and metadata reads", price: FREE, freshnessSeconds: 900, trustTier: "primary", readOnly: true, categories: ["opensource", "technology"] },
  { id: "sports-v1", capability: "sports_results", description: "Official fixture, result and standings sources", price: FREE, freshnessSeconds: 900, trustTier: "primary", readOnly: true, categories: ["sports", "gaming"] },
  { id: "weather-v1", capability: "weather_observations", description: "Official station forecasts and revised observations", price: FREE, freshnessSeconds: 900, trustTier: "primary", readOnly: true, categories: ["weather"] },
  { id: "market-data-v1", capability: "market_data", description: "Exchange and official market reference data", price: FREE, freshnessSeconds: 300, trustTier: "primary", readOnly: true, categories: ["crypto", "stocks"] },
  { id: "release-calendar-v1", capability: "release_calendar", description: "Official economic, product and event release calendars", price: FREE, freshnessSeconds: 3600, trustTier: "trusted", readOnly: true, categories: ["macro", "technology", "entertainment", "awards", "science"] },
  { id: "x402-bazaar-v1", capability: "x402_bazaar", description: "Paid source admitted through Bazaar price/capability policy", price: { currency: "USDC", maxAtomicPerRequest: "10000" }, freshnessSeconds: 900, trustTier: "discovered", readOnly: true, categories: ["crypto", "sports", "weather", "stocks", "macro", "technology", "opensource", "gaming", "entertainment", "awards", "science", "culture"] },
];

const BY_ID = new Map(RESEARCH_ADAPTERS.map((adapter) => [adapter.id, adapter]));
export function researchAdapter(id: string): ResearchAdapterManifest | null {
  return BY_ID.get(id.trim().toLowerCase()) ?? null;
}

export async function fetchWithAdapter(adapterId: string, args: GatewayFetchArgs): Promise<FetchResult | { ok: false; kind: "adapter"; detail: string }> {
  const adapter = researchAdapter(adapterId);
  if (!adapter) return { ok: false, kind: "adapter", detail: `unknown adapter '${adapterId}'` };
  if (adapter.trustTier === "discovered") return { ok: false, kind: "adapter", detail: "discovered endpoints require x402 admission and payment authorization" };
  return gatewayFetch(args);
}
