/**
 * Council reasoning, pay-per-read — creator monetization.
 *
 * GET /api/council/reasoning?claimId=12&persona=optimist       ($0.001 USDC / read)
 * GET /api/council/reasoning?market=BTC-0-19OCT26/tUSDC&persona=optimist
 *
 * Two subjects, one price. A claim lives on the Mimir contract; a market is a
 * DreamDEX binary. Only the claim form existed, and since the VS venue is empty
 * until somebody opens a claim, the council had nothing it could pay another
 * persona to read — which is why x402 revenue sat at zero while the agents
 * traded all day.
 *
 * Each of the 10 council personas is a "creator": a reader signs a small USDC
 * authorization to unlock that persona's take on a claim, and the USDC lands
 * DIRECTLY in that persona's own wallet (payTo = persona address).
 * Unpaid → PAYMENT-REQUIRED 402.
 */

import { NextResponse, type NextRequest } from "next/server";
import { paidRoute, queryParam } from "@/lib/x402/server";
import type { HTTPRequestContext } from "@x402/core/http";
import { PRICES } from "@/lib/x402/config";
import { verifyPass } from "@/lib/paid-pass";
import { getPersonaBySlug } from "@/agents/council/personas";
import { getCouncilAddress } from "@/lib/agent-wallets";
import { createSomniaPublicClient, getContractAddress } from "@/lib/chain";
import { MIMIR_ABI } from "@/lib/mimir-abi";
import { ZERO_ADDRESS } from "@/lib/constants";
import { callLLM } from "@/lib/llm";
import { getCachedReasoning, setCachedReasoning } from "@/lib/server/reasoning-cache";
import { loadDreamDexMarkets } from "@/lib/dreamdex-market";

const PASS_PLAN = "council";

/** Recipient of this read's payment — the persona itself, not the platform. */
function personaAddress(ctx: HTTPRequestContext): string {
  const slug = queryParam(ctx, "persona").toLowerCase().trim();
  const payTo = getCouncilAddress(slug);
  if (!payTo) throw new Error(`persona '${slug}' has no wallet configured`);
  return payTo;
}

/** A valid council pass unlocks reads for its window — no per-read payment. */
function hasCouncilPass(req: NextRequest): boolean {
  return !!verifyPass(req.nextUrl.searchParams.get("pass"), PASS_PLAN);
}

async function handler(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = req.nextUrl;
  const claimId = Number(searchParams.get("claimId"));
  const marketRef = (searchParams.get("market") ?? "").trim();
  const slug = (searchParams.get("persona") ?? "").toLowerCase().trim();
  const hasPass = hasCouncilPass(req);

  const persona = getPersonaBySlug(slug);
  if (!persona) {
    return NextResponse.json({ error: `unknown persona '${slug}'` }, { status: 400 });
  }
  const wantsMarket = marketRef.length > 0;
  if (!wantsMarket && (!Number.isInteger(claimId) || claimId < 1)) {
    return NextResponse.json(
      { error: "pass either a positive integer claimId or a market ref" },
      { status: 400 },
    );
  }
  // One cache namespace for both subjects; a market ref can never collide with
  // a claim id.
  const subject: number | string = wantsMarket ? `market:${marketRef}` : claimId;
  const payTo = getCouncilAddress(slug);
  if (!payTo) {
    return NextResponse.json({ error: `persona '${slug}' has no wallet configured` }, { status: 503 });
  }

  // A warm (claim, persona) pair skips both the contract read and the LLM call;
  // the read stays billed either way.
  const cached = getCachedReasoning(subject, slug);
  if (cached) {
    return NextResponse.json({
      persona: { slug: persona.slug, name: persona.displayName, emoji: persona.emoji },
      claimId: wantsMarket ? null : claimId,
      market: wantsMarket ? marketRef : null,
      question: cached.question,
      reasoning: cached.reasoning,
      paidTo: hasPass ? null : payTo,
      price: hasPass ? "$0 (pass)" : PRICES.councilReasoning,
    });
  }

  // Read the subject, then produce this persona's reasoning.
  let question = "";
  let sideA = "";
  let sideB = "";

  if (wantsMarket) {
    const markets = await loadDreamDexMarkets({ includeInactive: true }).catch(() => []);
    const market = markets.find(
      (m) =>
        m.symbol.toLowerCase() === marketRef.toLowerCase() ||
        m.id.toLowerCase() === marketRef.toLowerCase(),
    );
    if (!market) {
      return NextResponse.json({ error: `market '${marketRef}' not found` }, { status: 404 });
    }
    question = market.question || market.symbol;
    // A binary market has no stated sides, so the price is the thing to argue
    // with: it is the crowd's answer, and disagreeing with it is the read.
    const yes = market.lastPrice === null ? null : Math.round(market.lastPrice * 1000) / 10;
    sideA = yes === null ? "YES — no trades yet" : `YES — the market prices this at ${yes}%`;
    sideB = yes === null ? "NO — no trades yet" : `NO — the market prices this at ${(100 - yes).toFixed(1)}%`;
  } else {
  try {
    const base = (await createSomniaPublicClient().readContract({
      address: getContractAddress(),
      abi: MIMIR_ABI,
      functionName: "getClaim",
      args: [BigInt(claimId)],
    })) as readonly unknown[];
    if (!base[0] || base[0] === ZERO_ADDRESS) {
      return NextResponse.json({ error: `claim ${claimId} not found` }, { status: 404 });
    }
    question = String(base[1]);
    sideA = String(base[2]);
    sideB = String(base[3]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "read failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
  }

  const prompt = `${persona.promptBias}

You are giving your personal take, in character, on a prediction market claim.

**Question:** ${question}
**Side A:** ${sideA}
**Side B:** ${sideB}

Write one tight paragraph (max 90 words): which side you lean toward and your honest reasoning. Stay in character.`;

  let reasoning = "";
  try {
    reasoning = (await callLLM(prompt, { maxTokens: 300 })).trim();
    if (reasoning) {
      // Only successful generations are cached — never the fallback below.
      setCachedReasoning(subject, slug, { question, sideA, sideB, reasoning });
    }
  } catch {
    reasoning = "(reasoning unavailable right now)";
  }

  return NextResponse.json({
    persona: { slug: persona.slug, name: persona.displayName, emoji: persona.emoji },
    claimId: wantsMarket ? null : claimId,
    market: wantsMarket ? marketRef : null,
    question,
    reasoning,
    paidTo: hasPass ? null : payTo,
    price: hasPass ? "$0 (pass)" : PRICES.councilReasoning,
  });
}

// Dynamic payTo: each persona is paid into its own wallet. A council pass
// bypasses the paywall entirely.
export const GET = paidRoute("councilReasoning", handler, {
  payTo: personaAddress,
  skipPayment: hasCouncilPass,
});
