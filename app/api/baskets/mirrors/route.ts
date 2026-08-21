/**
 * GET /api/baskets/mirrors?subscriber=0x… — positions a follower has not copied yet.
 *
 * Read-only and unauthenticated: it reports what is already public (open markets
 * and who staked on them) filtered by a subscription the caller names. Nothing
 * here can move funds, and requiring a signature to read your own queue would buy
 * privacy that the chain does not offer anyway.
 */

import { NextResponse, type NextRequest } from "next/server";

import { apiError } from "@/lib/api/errors";
import { authorizeRequest } from "@/lib/api/policy";
import { listBasketSubscriptions } from "@/lib/db";
import { pendingMirrorsFor } from "@/lib/server/mirror-queue";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const subscriber = req.nextUrl.searchParams.get("subscriber") ?? "";
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const gate = authorizeRequest("public_read", { route: "/api/baskets/mirrors", ip });
  if (!gate.allowed && gate.error) {
    return NextResponse.json(gate.error.body, { status: gate.error.status, headers: gate.error.headers });
  }

  if (!/^0x[0-9a-fA-F]{40}$/.test(subscriber)) {
    const err = apiError("invalid_request", "subscriber must be an address");
    return NextResponse.json(err.body, { status: err.status });
  }

  const [mirrors, subscriptions] = await Promise.all([
    pendingMirrorsFor(subscriber).catch(() => []),
    listBasketSubscriptions(subscriber).catch(() => []),
  ]);

  return NextResponse.json(
    { mirrors, following: subscriptions },
    { headers: { "cache-control": "no-store" } },
  );
}
