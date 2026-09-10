/**
 * DreamDEX-native BYOA traders.
 *
 * Each persona owns a local EOA, reads indexed binary markets, chooses YES or
 * NO, and submits a bounded market buy through the official exchange SDK.
 * Private keys stay in this worker process and never enter a route or bundle.
 */
process.env.LLM_PROVIDER = "gemini";

import { createSomniaPublicClient, weiToStt } from "../../lib/chain";
import { loadAgentWallet, type AgentWallet } from "../../lib/agent-wallets";
import { createThrottle } from "../../lib/agent-bootstrap";
import {
  getDreamDexPortfolio,
  loadDreamDexMarkets,
  withDreamDexSigner,
  type DreamDexMarket,
} from "../../lib/dreamdex-market";
import { DREAMDEX_NETWORK } from "../../lib/dreamdex";
import { callLLM, activeLLMModel, activeLLMProvider, extractJson, pickGeminiModel } from "../../lib/llm";
import { reportingPoll } from "../../lib/ops/heartbeat";
import { AUTHORITY_LEVELS, defaultLimits, REGISTRY_SCHEMA_VERSION, type AgentRecord } from "../../lib/agents/registry";
import { loadAgent, saveAgent } from "../../lib/agents/store";
import { TRADER_PERSONAS, isTraderVerdict, shouldStake, type TraderPersona, type TraderVerdict } from "./personas";

const POLL_INTERVAL_MS = Number(process.env.TRADER_POLL_INTERVAL_MS ?? "900000");
const MAX_TRADES_PER_CYCLE = Number(process.env.TRADER_MAX_STAKES_PER_CYCLE ?? "1");
const DRY_RUN = process.env.TRADER_DRY_RUN === "1";
const MIN_GAS_STT = 0.0008;
const LLM_THROTTLE_MS = Number(process.env.TRADER_LLM_THROTTLE_MS ?? "8000");
const llmGate = createThrottle(LLM_THROTTLE_MS);

interface Decision {
  verdict: TraderVerdict;
  confidence: number;
  reasoning: string;
}

function walletFor(persona: TraderPersona): AgentWallet | null {
  try {
    return loadAgentWallet(persona.keyEnv);
  } catch {
    return null;
  }
}

function privateKeyFor(persona: TraderPersona): `0x${string}` | null {
  const raw = process.env[persona.keyEnv]?.trim();
  return raw && /^0x[0-9a-fA-F]{64}$/.test(raw) ? raw as `0x${string}` : null;
}

async function ensureRegistered(persona: TraderPersona, wallet: AgentWallet): Promise<AgentRecord> {
  const existing = await loadAgent(persona.agentId);
  if (existing) return existing;

  const now = Date.now();
  const record: AgentRecord = {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    agentId: persona.agentId,
    ownerWallet: wallet.address.toLowerCase(),
    operatorWallet: wallet.address.toLowerCase(),
    payoutWallet: wallet.address.toLowerCase(),
    displayName: persona.displayName,
    description: persona.description,
    capabilities: ["researcher"],
    authorityLevel: AUTHORITY_LEVELS.STAKE,
    limits: { ...defaultLimits(), maxPositionUsdc: persona.stakeUsdc, maxDailyExposureUsdc: persona.stakeUsdc * 4 },
    status: "active",
    reputationBps: 0,
    createdAt: now,
    updatedAt: now,
  };
  await saveAgent(record);
  console.log(`[traders] ${persona.emoji} registered ${persona.agentId} (${wallet.address})`);
  return record;
}

function decisionPrompt(persona: TraderPersona, market: DreamDexMarket): string {
  const hoursLeft = Math.max(0, Math.round((market.expiry * 1000 - Date.now()) / 3_600_000));
  return `${persona.strategy}

## Binary market
Question: ${market.question || "(missing)"}
Asset: ${market.asset}
Oracle rule: ${market.oracleQuestion ?? "protocol oracle"}
Current YES probability: ${market.lastPrice === null ? "unknown" : `${(market.lastPrice * 100).toFixed(2)}%`}
Settles at: ${new Date(market.expiry * 1000).toISOString()}
Time remaining: ${hoursLeft}h
Observed volume: ${market.volume.toFixed(4)} collateral

## Your decision
Choose the outcome you would buy with your own money. Say YES or NO to enter that
outcome, or ABSTAIN if the market cannot be judged from the information here.

## Calibrating confidence
Use the whole range. An unanchored 60 for everything is not a judgement.
- 50: a coin flip. Say ABSTAIN instead.
- 55-65: a lean you would not back with money.
- 66-79: you can name the specific evidence that makes your side more likely.
- 80+: the market needs something unusual to resolve against your side.

Reply with JSON only:
{"verdict":"YES"|"NO"|"ABSTAIN","confidence":0-100,"reasoning":"one or two sentences naming the specific evidence"}`;
}

async function decide(persona: TraderPersona, market: DreamDexMarket): Promise<Decision> {
  await llmGate();
  const text = await callLLM(decisionPrompt(persona, market), {
    maxTokens: 400,
    jsonOnly: true,
    temperature: 0.3,
    model: pickGeminiModel(persona.agentId),
  });
  try {
    const parsed = JSON.parse(extractJson(text) ?? "{}") as Partial<Decision>;
    const verdict = isTraderVerdict(parsed.verdict) ? parsed.verdict : "ABSTAIN";
    const confidence = Math.max(0, Math.min(100, Math.round(Number(parsed.confidence ?? 0))));
    return { verdict, confidence, reasoning: String(parsed.reasoning ?? "").slice(0, 300) };
  } catch {
    return { verdict: "ABSTAIN", confidence: 0, reasoning: "unparsable model response" };
  }
}

async function tradableFor(wallet: AgentWallet): Promise<DreamDexMarket[]> {
  const markets = await loadDreamDexMarkets({ includeInactive: false });
  const nowSeconds = Math.floor(Date.now() / 1000);
  const portfolio = await getDreamDexPortfolio(wallet.address).catch(() => null);
  const activeOrders = new Set((portfolio?.openOrders ?? []).map((order) => order.market.toLowerCase()));
  return markets.filter((market) =>
    market.status === "Trading" &&
    market.expiry > nowSeconds + 300 &&
    !activeOrders.has(market.symbol.toLowerCase()),
  );
}

function collateralBalance(balances: Record<string, { total: number }>): number {
  return Object.entries(balances)
    .find(([code]) => !code.includes("#") && /usdc|usdso|usd/i.test(code))?.[1].total ?? 0;
}

async function runTrader(persona: TraderPersona): Promise<void> {
  const wallet = walletFor(persona);
  const privateKey = privateKeyFor(persona);
  if (!wallet || !privateKey) {
    console.log(`[traders] ${persona.emoji} ${persona.agentId}: key not set or invalid, skipping`);
    return;
  }
  await ensureRegistered(persona, wallet);

  const gas = await createSomniaPublicClient().getBalance({ address: wallet.address });
  console.log(`[traders] ${persona.emoji} ${persona.displayName} · ${weiToStt(gas).toFixed(4)} STT`);
  if (weiToStt(gas) < MIN_GAS_STT) return void console.log("[traders]   out of gas, standing aside");

  const markets = await tradableFor(wallet);
  if (!markets.length) return void console.log("[traders]   nothing tradable this cycle");

  await withDreamDexSigner(privateKey, async (exchange) => {
    const balance = collateralBalance(await exchange.fetchBalance());
    console.log(`[traders]   collateral ${balance.toFixed(4)}`);
    if (balance < persona.stakeUsdc) {
      console.log(`[traders]   below ${persona.stakeUsdc} collateral, standing aside`);
      return;
    }

    let traded = 0;
    for (const market of markets) {
      if (traded >= MAX_TRADES_PER_CYCLE) break;
      const decision = await decide(persona, market);
      const take = shouldStake(decision.verdict, decision.confidence, persona);
      console.log(`[traders]   ${market.id.slice(0, 10)} ${decision.verdict} ${decision.confidence}% ${take ? "BUY" : "pass"} · ${decision.reasoning.slice(0, 90)}`);
      if (!take) continue;

      const outcome = decision.verdict as "YES" | "NO";
      const symbol = outcome === "YES" ? market.yesSymbol : market.noSymbol;
      if (DRY_RUN) {
        console.log(`[traders]   DRY_RUN — would buy ${outcome} for ${persona.stakeUsdc} collateral on ${market.symbol}`);
        traded += 1;
        continue;
      }

      try {
        const book = await exchange.fetchOrderBook(symbol, 5);
        const bestAsk = book.asks[0]?.[0];
        if (!bestAsk || bestAsk <= 0) {
          console.log(`[traders]   ${market.symbol} has no ask, skipping`);
          continue;
        }

        // An IOC limit at a snapped price, not a "market" order. The pool
        // rejects any price off its tick grid, and the SDK's market path prices
        // off the book without snapping — every buy reverted with
        // InvalidPrice(304750, 1000): 0.30475 against a 0.001 tick. Quantities
        // are on a lot grid for the same reason.
        const price = exchange.priceToPrecision(symbol, Math.min(bestAsk * 1.03, 0.999));
        const quantity = exchange.amountToPrecision(symbol, persona.stakeUsdc / price);
        if (!(quantity > 0)) {
          console.log(`[traders]   ${market.symbol} stake is under one lot at ${price}, skipping`);
          continue;
        }
        const order = await exchange.createOrder(symbol, "limit", "buy", quantity, price, { timeInForce: "IOC" });
        console.log(
          `[traders]   bought ${outcome} on ${market.symbol} · ${quantity.toFixed(4)} @ ${price.toFixed(4)} · ${order.txHash ?? order.id}`,
        );
        traded += 1;
      } catch (error) {
        console.warn(`[traders]   ${market.symbol} order failed:`, error instanceof Error ? error.message : error);
      }
    }
  });
}

async function poll(): Promise<void> {
  console.log(`\n[traders] cycle at ${new Date().toISOString()} · ${TRADER_PERSONAS.length} traders`);
  for (const persona of TRADER_PERSONAS) {
    try {
      await runTrader(persona);
    } catch (error) {
      console.error(`[traders] ${persona.agentId} failed:`, error instanceof Error ? error.message : error);
    }
  }
}

async function main(): Promise<void> {
  console.log("DreamDEX trader workers");
  console.log(`  Network: ${DREAMDEX_NETWORK}`);
  console.log(`  LLM: ${activeLLMProvider()} / ${activeLLMModel()}`);
  console.log(`  Traders: ${TRADER_PERSONAS.map((persona) => persona.agentId).join(", ")}`);
  console.log(`  Budget: ${TRADER_PERSONAS[0].stakeUsdc} collateral · max ${MAX_TRADES_PER_CYCLE}/cycle each`);
  console.log(`  Poll every: ${POLL_INTERVAL_MS / 1000}s${DRY_RUN ? " · DRY RUN" : ""}`);

  const safePoll = () => reportingPoll("traders", "traders", POLL_INTERVAL_MS / 1000, poll);
  await safePoll();
  setInterval(safePoll, POLL_INTERVAL_MS);
}

main().catch((error) => {
  console.error("[traders] fatal:", error);
  process.exit(1);
});
