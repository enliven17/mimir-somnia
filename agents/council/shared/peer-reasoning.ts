/**
 * Paid council-to-council reads.
 *
 * A persona can buy another persona's public reasoning before making its own
 * decision. This turns the council into a small information market instead of
 * ten isolated voters.
 */

import { fetchWithBudget, payingWalletFor, type PayingWallet } from "../../../lib/x402/buyer";
import { getCouncilWallet } from "../../../lib/agent-wallets";
import { usdcToUnits } from "../../../lib/usdc";
import {
  type PersonaSpec,
  personaPrivateKeyEnv,
} from "../personas";

export interface PeerReasoningRead {
  sellerSlug: string;
  sellerName: string;
  reasoning: string;
  pricePaidUnits: string | null;
}

interface ReasoningResponse {
  reasoning?: string;
  persona?: {
    slug?: string;
    name?: string;
  };
}

function payingWalletForPersona(persona: PersonaSpec): PayingWallet | null {
  if (!process.env[personaPrivateKeyEnv(persona)]) return null;
  try {
    return payingWalletFor(getCouncilWallet(persona.slug));
  } catch {
    return null;
  }
}

/** Stable rotation seed for a subject that may be an id or a market ref. */
function subjectSeed(subject: number | string): number {
  if (typeof subject === "number") return subject;
  let hash = 0;
  for (let i = 0; i < subject.length; i++) hash = (hash * 31 + subject.charCodeAt(i)) >>> 0;
  return hash;
}

function selectPeerSellers(
  buyer: PersonaSpec,
  activePersonas: PersonaSpec[],
  subject: number | string,
  count: number,
): PersonaSpec[] {
  const peers = activePersonas.filter((persona) => persona.slug !== buyer.slug);
  if (peers.length <= count) return peers;

  const buyerIndex = activePersonas.findIndex((persona) => persona.slug === buyer.slug);
  const offset = Math.max(0, buyerIndex) + subjectSeed(subject);
  const rotated = [...peers.slice(offset % peers.length), ...peers.slice(0, offset % peers.length)];
  return rotated.slice(0, count);
}

export async function buyPeerReasoning(args: {
  buyer: PersonaSpec;
  activePersonas: PersonaSpec[];
  /**
   * What the reads are about. A claim lives on the Mimir contract; a market is
   * a DreamDEX binary. Only claims used to be buyable, and with the VS venue
   * empty that meant no persona ever paid another — x402 revenue stayed at zero
   * while the council traded all day.
   */
  claimId?: number;
  market?: string;
  baseUrl: string;
  readsPerPersona: number;
  capUsdc: number;
  delayMs: number;
}): Promise<PeerReasoningRead[]> {
  if (args.readsPerPersona <= 0) return [];

  const payer = payingWalletForPersona(args.buyer);
  if (!payer) {
    console.warn(`[council:${args.buyer.slug}] no paying wallet — peer reads skipped`);
    return [];
  }

  const subject = args.market ? `market:${args.market}` : args.claimId;
  if (subject === undefined) return [];

  const capUnits = usdcToUnits(args.capUsdc);
  const sellers = selectPeerSellers(
    args.buyer,
    args.activePersonas,
    subject,
    args.readsPerPersona,
  );
  const reads: PeerReasoningRead[] = [];

  for (const seller of sellers) {
    const subjectParam = args.market
      ? `market=${encodeURIComponent(args.market)}`
      : `claimId=${encodeURIComponent(String(args.claimId))}`;
    const url =
      `${args.baseUrl.replace(/\/$/, "")}/api/council/reasoning` +
      `?${subjectParam}&persona=${encodeURIComponent(seller.slug)}`;

    try {
      const result = await fetchWithBudget(url, payer, capUnits, {
        method: "GET",
        headers: { accept: "application/json" },
      });
      // Silence here is how this failed for weeks: every paid route was
      // answering 500 and each read was skipped without a word, so the council
      // looked like it had simply chosen not to buy.
      if (!result.response.ok) {
        console.warn(
          `[council:${args.buyer.slug}] peer read from ${seller.slug} returned ${result.response.status}: ` +
          `${(await result.response.text().catch(() => "")).slice(0, 140)}`,
        );
        continue;
      }

      const body = (await result.response.json()) as ReasoningResponse;
      const reasoning = String(body.reasoning ?? "").trim();
      if (!reasoning) {
        console.warn(`[council:${args.buyer.slug}] peer read from ${seller.slug} paid but returned no reasoning`);
        continue;
      }

      reads.push({
        sellerSlug: body.persona?.slug ?? seller.slug,
        sellerName: body.persona?.name ?? seller.displayName,
        reasoning: reasoning.slice(0, 360),
        pricePaidUnits: result.payment?.priceUnits?.toString() ?? null,
      });
    } catch (err) {
      console.warn(
        `[council:${args.buyer.slug}] peer read failed from ${seller.slug}:`,
        err instanceof Error ? err.message : err,
      );
    }

    if (args.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, args.delayMs));
    }
  }

  return reads;
}
