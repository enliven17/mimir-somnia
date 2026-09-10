/**
 * Mimir Council Worker
 *
 * Boots a single Node process that runs 10 AI personas as autonomous
 * economic actors on Somnia. Every cycle:
 *
 *   1. Reads claimCount + each open/active claim from the contract.
 *   2. Builds a per-cycle evidence cache so 10 personas share 1 HTTP
 *      fetch per resolution URL.
 *   3. For each (claim, persona) pair, runs the decision pipeline:
 *        - Specialists skip out-of-category claims (no LLM call)
 *        - Rule-based personas evaluate from pool state (no LLM call)
 *        - LLM personas call Gemini with a persona-specific prompt prefix
 *   4. Submits challengeClaim through the persona's local private-key wallet when the
 *      decision says stake.
 *
 * Rate-limit strategy:
 *   - Personas are processed sequentially within a cycle (not in parallel).
 *   - Gemini free tier = 15 req/min. With 10 LLM personas across ~60s of
 *     work per cycle, we stay comfortably under.
 *   - Rule-based + category-filtered personas don't consume LLM budget.
 *
 * Run: npm run council  (or via "npm run workers" alongside oracle + market-creator)
 * Env: COUNCIL_<SLUG>_PRIVATE_KEY for each persona (addresses derived),
 *      NEXT_PUBLIC_CONTRACT_ADDRESS,
 *      GEMINI_API_KEY (preferred) OR ANTHROPIC_API_KEY
 *      COUNCIL_PERSONAS_ACTIVE (optional CSV of slugs, e.g.
 *        "optimist,pessimist,statistician,whale_watcher,doomer" — restricts
 *        active personas to this subset, cuts LLM load proportionally).
 */

// Worker-scoped Gemini key. Falls back to the shared GEMINI_API_KEY when
// COUNCIL_GEMINI_API_KEY is not set. See agents/oracle/index.ts for the
// rationale: each worker gets its own 20 RPM free-tier bucket.
applyWorkerGeminiKey("COUNCIL_GEMINI_API_KEY");

import { requireAnyLLMKey, applyWorkerGeminiKey } from "../../lib/agent-bootstrap";
import {
  createSomniaPublicClient,
  somniaShannon,
  getContractAddress,
  weiToStt,
} from "../../lib/chain";
const weiToEth = weiToStt;
import { ERC20_ABI, unitsToUsdc } from "../../lib/usdc";
import { COLLATERAL } from "../../lib/dreamdex";
import { MIMIR_ABI, STATE } from "../../lib/mimir-abi";
import { reportingPoll } from "../../lib/ops/heartbeat";
import { fetchDecodedClaim } from "../../lib/claim-codec";
import { activeLLMProvider, activeLLMModel, activeLLMKeyFingerprint } from "../../lib/llm";
import {
  listCouncilPersonas,
  personaAddressEnv,
  personaPrivateKeyEnv,
  type PersonaSpec,
} from "./personas";
import {
  PHILOSOPHER_PERSONAS,
  activePhilosophers,
  isPhilosopher,
  philosopherAddressEnv,
  philosopherPrivateKeyEnv,
} from "./philosophers";
import { runPersonaForClaim } from "./shared/persona-runner";
import { runPersonaForMarket, toCouncilMarket } from "./shared/market-runner";
import { loadDreamDexMarkets, withDreamDexSigner } from "../../lib/dreamdex-market";
import { buyPeerReasoning } from "./shared/peer-reasoning";
import type {
  ClaimOnChain,
  PersonaRunnerContext,
  EvidenceCacheEntry,
} from "./shared/types";

const POLL_INTERVAL_MS = Number(process.env.COUNCIL_POLL_INTERVAL_MS ?? 180_000);
/**
 * Per-cycle work cap to stay under Gemini free-tier rate limits.
 * Claims are sorted by deadline-proximity so the council focuses on
 * the markets closest to settling.
 */
const MAX_CLAIMS_PER_CYCLE = Number(process.env.COUNCIL_MAX_CLAIMS ?? 1);
const DECISION_DELAY_MS    = Number(process.env.COUNCIL_DECISION_DELAY_MS ?? 30000);
const PEER_READS_ENABLED   = process.env.COUNCIL_PEER_READS === "1";
const PEER_READS_APP_URL  = process.env.MIMIR_APP_URL ?? "http://localhost:3000";
const PEER_READS_PER_PERSONA = Number(process.env.COUNCIL_PEER_READS_PER_PERSONA ?? 2);
const PEER_READ_DELAY_MS   = Number(process.env.COUNCIL_PEER_READ_DELAY_MS ?? 15000);
const PEER_READ_CAP_USDC   = Number(process.env.COUNCIL_PEER_READ_CAP_USDC ?? "0.003");
const MARKETS_PER_CYCLE    = Number(process.env.COUNCIL_MAX_MARKETS ?? 2);
const DREAMDEX_ENABLED     = process.env.COUNCIL_DREAMDEX !== "0";
const DRY_RUN              = process.env.COUNCIL_DRY_RUN === "1";
/**
 * Only consider markets with enough life left to survive a cycle.
 *
 * A cycle walks 20 personas over every market in scope, and the venue lists
 * markets that settle within the hour. At 300s of headroom the council kept
 * picking markets that expired before the later personas reached them.
 */
const MIN_HEADROOM_SECONDS = Number(process.env.COUNCIL_MIN_HEADROOM_SECONDS ?? 1800);
const CONTRACT_ADDRESS     = getContractAddress();
const publicClient         = createSomniaPublicClient();

// ── Env guard ─────────────────────────────────────────────────────────────────
requireAnyLLMKey();

// Optional CSV allowlist of persona slugs to keep active. When set, personas
// not in the list are skipped even if their wallets exist — used to scale LLM
// load down without re-provisioning wallets.
const PERSONA_ALLOWLIST = (() => {
  const raw = process.env.COUNCIL_PERSONAS_ACTIVE?.trim();
  if (!raw) return null;
  const slugs = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return slugs.length > 0 ? new Set(slugs) : null;
})();

// Skip personas missing a private key (e.g. before agents:create-wallets has
// run for that persona). Warn once at startup, not every cycle.
const CLASSIC_PERSONAS = listCouncilPersonas();
const ACTIVE_PERSONAS = CLASSIC_PERSONAS.filter((p) => {
  if (PERSONA_ALLOWLIST && !PERSONA_ALLOWLIST.has(p.slug)) {
    return false;
  }
  const ok = !!process.env[personaPrivateKeyEnv(p)];
  if (!ok) {
    console.warn(
      `[council] ${p.emoji} ${p.displayName} is missing ${personaPrivateKeyEnv(p)} — skipping. ` +
      `Run "npm run agents:create-wallets" to provision.`,
    );
  }
  return ok;
});

/**
 * The philosopher track (§04) runs alongside the classic personas.
 *
 * Kept as a separate list rather than merged into COUNCIL_PERSONAS so the two
 * juries can be filtered, funded and scaled independently — and so a combined
 * consensus can be computed without first having to work out which persona
 * belonged to which track. `COUNCIL_PHILOSOPHERS=0` runs the classic jury alone.
 *
 * Each philosopher carries its own wallet env and its own risk limits; a
 * philosopher with no key is skipped exactly like a classic persona, so the track
 * degrades to whatever has been provisioned instead of failing the worker.
 */
const PHILOSOPHERS_ENABLED = process.env.COUNCIL_PHILOSOPHERS !== "0";
const ACTIVE_PHILOSOPHERS: PersonaSpec[] = PHILOSOPHERS_ENABLED
  ? activePhilosophers().filter((p) => {
      const ok = !!process.env[philosopherPrivateKeyEnv(p.slug)];
      if (!ok) {
        console.warn(
          `[council] ${p.emoji} ${p.displayName} is missing ${philosopherPrivateKeyEnv(p.slug)} — skipping. ` +
          `Run "npm run agents:create-wallets" to provision.`,
        );
      }
      return ok;
    })
  : [];

/** Both juries, in one list for the cycle loop. Track stays readable per persona. */
const ALL_ACTIVE = [...ACTIVE_PERSONAS, ...ACTIVE_PHILOSOPHERS];

if (ALL_ACTIVE.length === 0) {
  console.error("[council] No personas have wallets configured. Exiting.");
  process.exit(1);
}

// ── Fetch claim ───────────────────────────────────────────────────────────────
async function fetchClaim(claimId: number): Promise<ClaimOnChain | null> {
  try {
    const decoded = await fetchDecodedClaim(publicClient, CONTRACT_ADDRESS, claimId);
    if (!decoded) return null;
    return {
      id:                   decoded.id,
      creator:              decoded.creator,
      question:             decoded.question,
      creatorPosition:      decoded.creatorPosition,
      counterPosition:      decoded.counterPosition,
      resolutionUrl:        decoded.resolutionUrl,
      creatorStake:         decoded.creatorStake,
      totalChallengerStake: decoded.totalChallengerStake,
      deadline:             decoded.deadline,
      state:                decoded.state,
      category:             decoded.category,
      challengerCount:      decoded.challengerCount,
      marketType:           decoded.marketType,
      settlementRule:       decoded.settlementRule,
      maxChallengers:       decoded.maxChallengers,
      isPrivate:            decoded.isPrivate,
    };
  } catch {
    return null;
  }
}

// ── Wallet env per track ──────────────────────────────────────────────
// Classic personas and philosophers keep their keys under different env names,
// so ask the track rather than assuming one shape.
function privateKeyEnvFor(persona: PersonaSpec): string {
  return isPhilosopher(persona)
    ? philosopherPrivateKeyEnv(persona.slug)
    : personaPrivateKeyEnv(persona);
}

function addressEnvFor(persona: PersonaSpec): string {
  return isPhilosopher(persona)
    ? philosopherAddressEnv(persona.slug)
    : personaAddressEnv(persona);
}

function personaPrivateKey(persona: PersonaSpec): `0x${string}` | null {
  const raw = process.env[privateKeyEnvFor(persona)]?.trim();
  return raw && /^0x[0-9a-fA-F]{64}$/.test(raw) ? (raw as `0x${string}`) : null;
}

/**
 * Spendable collateral for this persona, read from the token itself.
 *
 * The venue's own balance call is what a persona used to be gated on, and it
 * answers 0 for a funded wallet often enough to matter: the same wallet that
 * held 20 was told it had nothing and stood aside, in the council and in the
 * traders alike. An order settles against the wallet's ERC-20 balance anyway —
 * a buy of 1.5 took that wallet from 20.00 to 18.54 — so the token is both the
 * authority and the reading that does not flicker.
 */
async function collateralBalance(address: `0x${string}`): Promise<number> {
  const raw = (await publicClient.readContract({
    address: COLLATERAL as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [address],
  })) as bigint;
  return unitsToUsdc(raw);
}

// ── DreamDEX phase ─────────────────────────────────────────────────
/**
 * The council's second venue: the protocol's own binary event markets.
 *
 * VS claims (below) only exist once a user opens one, and the council sat idle
 * whenever nobody had — while the market-creator was filling DreamDEX with
 * markets no persona ever looked at. Both juries now vote on both venues.
 */
async function pollMarkets(): Promise<number> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const all = await loadDreamDexMarkets({ includeInactive: false, reload: true });

  // Closest to settling first, same priority the claim phase uses: those are
  // the markets where a persona's read is about to be graded.
  const tradable = all
    .filter((market) => market.status === "Trading" && market.expiry > nowSeconds + MIN_HEADROOM_SECONDS)
    .sort((a, b) => a.expiry - b.expiry)
    .slice(0, MARKETS_PER_CYCLE)
    .map(toCouncilMarket);

  console.log(
    `[council] DreamDEX: ${tradable.length} of ${all.length} market(s) in scope this cycle`,
  );
  if (tradable.length === 0) return 0;

  let buys = 0;
  for (const persona of ALL_ACTIVE) {
    const privateKey = personaPrivateKey(persona);
    if (!privateKey) continue;

    try {
      const address = process.env[addressEnvFor(persona)] as `0x${string}` | undefined;
      if (!address) continue;
      const bankroll = await collateralBalance(address);

      await withDreamDexSigner(privateKey, async (exchange) => {
        // A persona that already holds or bid on a market has made its call
        // there; re-buying would average into a position it already sized.
        const balances = await exchange.fetchBalance();
        const openOrders = await exchange.fetchOpenOrders().catch(() => []);
        const engagedRefs = new Set<string>([
          ...openOrders.map((order: { symbol?: string }) => (order.symbol ?? "").split("#")[0].toLowerCase()),
          ...Object.entries(balances)
            .filter(([code, balance]) => code.includes("#") && (balance as { total: number }).total > 0)
            .map(([code]) => code.split("#")[0].toLowerCase()),
        ]);

        for (const market of tradable) {
          // Per market, not per persona: a symbol the venue has forgotten or a
          // book that cannot be read must cost this one decision, not the rest
          // of this persona's cycle.
          try {
            const receipt = await runPersonaForMarket({
              persona,
              market,
              exchange: exchange as never,
              bankrollUsdc: bankroll,
              engagedRefs,
              dryRun: DRY_RUN,
            });
            if (receipt) {
              buys += 1;
              engagedRefs.add(market.ref.toLowerCase());
            }
          } catch (err) {
            console.warn(
              `[council:${persona.slug}] ${market.ref} failed:`,
              err instanceof Error ? err.message.slice(0, 120) : err,
            );
          }
        }
      });
    } catch (err) {
      console.error(
        `[council:${persona.slug}] DreamDEX phase failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return buys;
}

// ── Poll loop ─────────────────────────────────────────────────────────────────
async function pollClaims(): Promise<number> {
  const now = BigInt(Math.floor(Date.now() / 1000));

  let total: bigint;
  try {
    total = await publicClient.readContract({
      address: CONTRACT_ADDRESS, abi: MIMIR_ABI, functionName: "claimCount",
    }) as bigint;
  } catch (err) {
    console.warn("[council] Failed to read claimCount:", err);
    return 0;
  }

  console.log(
    `\n[council] ── Poll at ${new Date().toISOString()} ── VS claims: ${total} · personas: ${ALL_ACTIVE.length}`,
  );

  // Shared per-cycle evidence cache — one HTTP fetch per claim no matter
  // how many personas need it.
  const evidenceCache = new Map<number, EvidenceCacheEntry>();
  const peerReasoning = new Map<string, string[]>();
  const ctx: PersonaRunnerContext = {
    publicClient,
    contractAddress: CONTRACT_ADDRESS,
    evidenceCache,
    peerReasoning,
  };

  // Pre-load joinable claims so we don't refetch in the inner loop.
  const allClaims: ClaimOnChain[] = [];
  for (let id = 1; id <= Number(total); id++) {
    const claim = await fetchClaim(id);
    if (!claim) continue;
    const joinable =
      (claim.state === STATE.OPEN || claim.state === STATE.ACTIVE) &&
      claim.deadline > now;
    if (joinable) allClaims.push(claim);
  }
  if (allClaims.length === 0) {
    console.log("[council] VS: no joinable claims this round.");
    return 0;
  }

  // Focus on claims closest to settling — they're the most interesting for
  // the council to weigh in on and keeps LLM-call volume bounded.
  allClaims.sort((a, b) => Number(a.deadline - b.deadline));
  const claims = allClaims.slice(0, MAX_CLAIMS_PER_CYCLE);
  if (claims.length < allClaims.length) {
    console.log(
      `[council] Evaluating ${claims.length} of ${allClaims.length} joinable claims this cycle (deadline-prioritized).`,
    );
  }

  let stakesThisCycle = 0;

  for (const persona of ALL_ACTIVE) {
    for (const claim of claims) {
      try {
        if (PEER_READS_ENABLED && PEER_READS_PER_PERSONA > 0) {
          const reads = await buyPeerReasoning({
            buyer: persona,
            activePersonas: ALL_ACTIVE,
            claimId: claim.id,
            baseUrl: PEER_READS_APP_URL,
            readsPerPersona: PEER_READS_PER_PERSONA,
            capUsdc: PEER_READ_CAP_USDC,
            delayMs: PEER_READ_DELAY_MS,
          });
          if (reads.length > 0) {
            const formattedReads = reads.map(
              (read) => `${read.sellerName}: ${read.reasoning}`,
            );
            peerReasoning.set(`${claim.id}:${persona.slug}`, formattedReads);
            const paidUsdc = reads.reduce(
              (sum, read) => sum + unitsToUsdc(BigInt(read.pricePaidUnits ?? "0")),
              0,
            );
            console.log(
              `[council:${persona.slug}] bought ${reads.length} peer read(s) for claim #${claim.id} ` +
              `(${paidUsdc.toFixed(6)} USDC)`,
            );
          }
        }
        const receipt = await runPersonaForClaim(persona, claim, ctx);
        if (receipt) stakesThisCycle += 1;
      } catch (err) {
        console.error(
          `[council:${persona.slug}] error on claim #${claim.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
      if (DECISION_DELAY_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, DECISION_DELAY_MS));
      }
    }
  }

  return stakesThisCycle;
}

/**
 * One cycle over both venues.
 *
 * The two phases are independent on purpose: a legacy contract with no claims
 * must not stop the council from trading DreamDEX, and a DreamDEX outage must
 * not stop it from answering a VS claim.
 */
async function poll(): Promise<void> {
  let stakes = 0;
  try {
    stakes += await pollClaims();
  } catch (err) {
    console.error("[council] VS phase failed:", err instanceof Error ? err.message : err);
  }

  if (DREAMDEX_ENABLED) {
    try {
      stakes += await pollMarkets();
    } catch (err) {
      console.error("[council] DreamDEX phase failed:", err instanceof Error ? err.message : err);
    }
  }

  console.log(
    stakes > 0
      ? `[council] Cycle complete — ${stakes} position(s) opened.`
      : "[council] Cycle complete — no new positions.",
  );
}

// ── Entry ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════");
  console.log("  Mimir Council — 10 AI personas as economic actors");
  console.log(`  Contract       : ${CONTRACT_ADDRESS}`);
  console.log(`  Network        : Somnia Shannon testnet (${somniaShannon.id})`);
  console.log(`  LLM            : ${activeLLMProvider()} / ${activeLLMModel()} · key=${activeLLMKeyFingerprint()}`);
  console.log(`  Active personas: ${ACTIVE_PERSONAS.length} / ${CLASSIC_PERSONAS.length}`);
  console.log(`  Philosophers   : ${PHILOSOPHERS_ENABLED ? `${ACTIVE_PHILOSOPHERS.length} / ${PHILOSOPHER_PERSONAS.length}` : "off"}`);
  console.log(`  Max claims/cycle: ${MAX_CLAIMS_PER_CYCLE}`);
  console.log(`  DreamDEX       : ${DREAMDEX_ENABLED ? `${MARKETS_PER_CYCLE} market(s)/cycle` : "off"}${DRY_RUN ? " · DRY RUN" : ""}`);
  console.log(`  Decision gap   : ${DECISION_DELAY_MS / 1000}s`);
  console.log(`  Peer reads     : ${PEER_READS_ENABLED ? `${PEER_READS_PER_PERSONA}/persona via ${PEER_READS_APP_URL}` : "off"}`);
  console.log(`  Peer read gap  : ${PEER_READ_DELAY_MS / 1000}s`);
  console.log(`  Poll every     : ${POLL_INTERVAL_MS / 1000}s`);
  console.log("───────────────────────────────────────────────");

  for (const p of ALL_ACTIVE) {
    // Address env differs per track, so ask the right one rather than assuming.
    const addr = (isPhilosopher(p)
      ? process.env[philosopherAddressEnv(p.slug)]
      : process.env[personaAddressEnv(p)]) as `0x${string}`;
    const bal  = await publicClient.getBalance({ address: addr }).catch(() => 0n);
    console.log(
      `  ${p.emoji} ${p.displayName.padEnd(22)} ${addr.slice(0, 6)}…${addr.slice(-4)} · ${weiToEth(bal).toFixed(4)} ETH`,
    );
  }
  console.log("═══════════════════════════════════════════════\n");

  const safePoll = () => reportingPoll("council", "council", POLL_INTERVAL_MS / 1000, poll);

  await safePoll();
  setInterval(safePoll, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("[council] fatal:", err);
  process.exit(1);
});
