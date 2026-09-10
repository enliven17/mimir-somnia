/**
 * Persona evaluation of a DreamDEX binary market.
 *
 * The claim prompt next door asks a persona whether to object to someone
 * else's stated position, because on the Mimir contract that is the only move
 * available to it. A binary market has no creator to disagree with: both
 * outcomes are tradeable, so the question here is which side the persona would
 * buy, and the answer includes the market's own price as evidence to argue with.
 */

import { callLLM, pickGeminiModel, extractJson } from "../../../lib/llm";
import type { PersonaSpec } from "../personas";
import type { CouncilMarket, MarketOutcome } from "./types";

export interface MarketVerdict {
  /** ABSTAIN when the persona would not put its own money on either side. */
  verdict:     MarketOutcome | "ABSTAIN";
  confidence:  number;
  explanation: string;
}

function isMarketVerdict(value: unknown): value is MarketVerdict["verdict"] {
  return value === "YES" || value === "NO" || value === "ABSTAIN";
}

function probabilityLine(market: CouncilMarket): string {
  if (market.yesProbability === null) {
    return "No trades yet — the market has no opinion for you to agree or disagree with.";
  }
  const yes = market.yesProbability * 100;
  return `YES trades at ${yes.toFixed(1)}% (NO at ${(100 - yes).toFixed(1)}%).`;
}

export async function evaluateMarketAsPersona(
  persona: PersonaSpec,
  market: CouncilMarket,
  peerReasoning: string[] = [],
): Promise<MarketVerdict> {
  const hoursLeft = Math.max(0, Math.round((market.expiry * 1000 - Date.now()) / 3_600_000));

  const biasSection = persona.promptBias
    ? `\n## Your character\n${persona.promptBias}\n`
    : "";
  const peerSection = peerReasoning.length > 0
    ? `\n## Paid peer reads you bought over x402 (USDC)\n${peerReasoning.map((read, i) => `${i + 1}. ${read}`).join("\n")}\n\nThese are other council members' opinions, not primary evidence. You may agree, dissent, or discount them.\n`
    : "";

  const prompt = `You are ${persona.displayName}, one of the AI personas on the Mimir Council — a jury that trades its own money on Somnia event markets.
${biasSection}
## Time context (TRUST THIS, ignore your training cutoff)
- Current UTC time: ${new Date().toISOString()}
- Market settles:   ${new Date(market.expiry * 1000).toISOString()} (${hoursLeft}h away)

## Binary market
**Question:** ${market.question || "(missing)"}
**Asset:** ${market.asset}
**Category:** ${market.category}
**Settlement rule:** ${market.oracleQuestion ?? "the protocol oracle settles this market"}
**Market price:** ${probabilityLine(market)}
**Traded so far:** ${market.volume.toFixed(4)} collateral across ${market.tradeCount} trades
${peerSection}
Decide which outcome you would buy with your own money, at the price above.

The price is the crowd's answer. Buying YES only pays off if the true chance is
higher than the quoted YES price, and buying NO only pays off if it is lower —
so name where you think the price is wrong, not merely which outcome sounds
likely. ABSTAIN when the price looks about right, or when nothing here lets you
judge the question.

## Calibrating confidence
Use the whole range. An unanchored 60 on everything is not a judgement.
- 50: a coin flip. ABSTAIN instead.
- 55-65: a lean you would not back with money.
- 66-79: you can name the specific reason the price is mispriced.
- 80+: the market needs something unusual to settle against you.

Return JSON only:
{
  "verdict": "YES" | "NO" | "ABSTAIN",
  "confidence": <0-100>,
  "explanation": "<one or two sentences in your voice, naming what the price gets wrong>"
}

- Stay in character (${persona.displayName}) when writing the explanation.
- Never invent data. Reason from the market above.`;

  const text = await callLLM(prompt, {
    maxTokens: 512,
    jsonOnly: true,
    model: pickGeminiModel(persona.slug),
  });

  try {
    const jsonStr = extractJson(text);
    if (!jsonStr) throw new Error("No JSON");
    const parsed = JSON.parse(jsonStr) as MarketVerdict;
    if (!isMarketVerdict(parsed.verdict)) throw new Error("Invalid verdict");
    return {
      verdict:     parsed.verdict,
      confidence:  Math.max(0, Math.min(100, Math.round(Number(parsed.confidence ?? 50)))),
      explanation: String(parsed.explanation ?? "").slice(0, 500),
    };
  } catch {
    return {
      verdict:     "ABSTAIN",
      confidence:  0,
      explanation: `[${persona.displayName} failed to parse LLM response]`,
    };
  }
}
