import { NextResponse } from "next/server";
import { isAddress, type Address } from "viem";

import { getDreamDexPortfolio } from "@/lib/dreamdex-market";
import { createApiError } from "@/lib/server/api-validation";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params;
  if (!isAddress(address)) {
    return NextResponse.json(createApiError("invalid_parameter", "Invalid wallet address"), { status: 400 });
  }

  try {
    const portfolio = await getDreamDexPortfolio(address as Address);
    return NextResponse.json(
      { item: portfolio, source: "dreamdex" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[portfolio] unable to load DreamDEX portfolio", error);
    return NextResponse.json(
      createApiError("upstream_unavailable", "Unable to load DreamDEX portfolio"),
      { status: 503 },
    );
  }
}
