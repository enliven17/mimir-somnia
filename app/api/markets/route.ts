import { NextResponse } from "next/server";

import { loadDreamDexMarkets } from "@/lib/dreamdex-market";
import { createApiError } from "@/lib/server/api-validation";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const includeInactive = searchParams.get("includeInactive") === "1";
    const requestedLimit = Number(searchParams.get("limit") ?? "100");
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 250)
      : 100;
    const status = searchParams.get("status")?.trim();
    const items = (await loadDreamDexMarkets({ includeInactive }))
      .filter((market) => !status || market.status.toLowerCase() === status.toLowerCase())
      .slice(0, limit);

    return NextResponse.json(
      { items, count: items.length, source: "dreamdex" },
      { headers: { "Cache-Control": "public, max-age=5, stale-while-revalidate=15" } },
    );
  } catch (error) {
    console.error("[markets] unable to load DreamDEX markets", error);
    return NextResponse.json(
      createApiError("upstream_unavailable", "Unable to load DreamDEX markets"),
      { status: 503 },
    );
  }
}
