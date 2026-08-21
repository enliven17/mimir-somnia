import { NextResponse } from "next/server";

import { getDreamDexMarket, getDreamDexOrderBook } from "@/lib/dreamdex-market";
import { createApiError } from "@/lib/server/api-validation";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const marketResult = await getDreamDexMarket(id);
    const searchParams = new URL(request.url).searchParams;
    const outcomeValue = (searchParams.get("outcome") ?? "YES").toUpperCase();
    if (outcomeValue !== "YES" && outcomeValue !== "NO") {
      return NextResponse.json(
        createApiError("invalid_parameter", "outcome must be YES or NO"),
        { status: 400 },
      );
    }

    const includeBook = searchParams.get("book") !== "0";
    const requestedDepth = Number(searchParams.get("depth") ?? "50");
    const depth = Number.isInteger(requestedDepth) && requestedDepth > 0
      ? Math.min(requestedDepth, 200)
      : 50;
    const orderBook = includeBook
      ? await getDreamDexOrderBook(id, outcomeValue as "YES" | "NO", depth)
      : null;

    return NextResponse.json(
      { item: marketResult.market, orderBook, source: "dreamdex" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "DreamDEX market not found") {
      return NextResponse.json(createApiError("not_found", "Market not found"), { status: 404 });
    }
    console.error("[markets] unable to load DreamDEX market", error);
    return NextResponse.json(
      createApiError("upstream_unavailable", "Unable to load DreamDEX market"),
      { status: 503 },
    );
  }
}
