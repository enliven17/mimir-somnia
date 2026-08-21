/**
 * Fan real activity across many wallets: create wallets, spread the float, open
 * markets from live sources, and place the smallest stake the contract allows on
 * every claim each wallet has not already taken a side in.
 *
 *   DRY_RUN=1 npx tsx --env-file-if-exists=.env.local scripts/seed-traction.ts
 *   npx tsx --env-file-if-exists=.env.local scripts/seed-traction.ts
 *   ... scripts/seed-traction.ts --wallets 40 --markets 10
 *   ... scripts/seed-traction.ts --bet-only        (skip funding and creation)
 *
 * ── The two ceilings ────────────────────────────────────────────────────────
 *
 * MIN_STAKE is 2 USDC in the contract, so "small" bottoms out there. And USDC on
 * Somnia Shannon testnet is Circle's, not ours: it cannot be minted, only received. Total
 * concurrent bets are therefore held at (USDC we hold) / 2, no matter how many
 * wallets exist or how much ETH arrives. Gas is nowhere near binding — a stake is
 * two cheap calls, and the float already covers thousands of them.
 *
 * Staked USDC is not spent, it is locked: settlement returns it to whichever side
 * won. So capacity comes back as markets resolve, and re-running this picks up
 * the freed float.
 *
 * Wallet keys are appended to traction-wallets.env (gitignored) and reused on the
 * next run. That file IS the money: a fresh set of wallets each run would strand
 * the float in addresses nothing can sign for.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";

import { formatEther, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { fetchLaunchEvents, fetchWeatherEvents } from "../agents/market-creator/sources";
import { COUNCIL_PERSONAS, personaPrivateKeyEnv } from "../agents/council/personas";
import { PHILOSOPHER_PERSONAS, philosopherPrivateKeyEnv } from "../agents/council/philosophers";
import {
  createSomniaPublicClient,
  createSomniaWalletClientWithKey,
  getContractAddress,
  weiToStt,
} from "../lib/chain";
import { agentContractWrite, loadAgentWallet, type AgentWallet } from "../lib/agent-wallets";
import { MIMIR_ABI } from "../lib/mimir-abi";
import { ERC20_ABI, USDC_ADDRESS, unitsToUsdc, usdcToUnits } from "../lib/usdc";

const WALLET_FILE = "traction-wallets.env";

/** Mirrors MimirV2's claim states; challengeClaim accepts only these two. */
const ST_OPEN = 0;
const ST_ACTIVE = 1;

/** The contract's floor. Nothing here can go lower. */
const BET_USDC = 2;
/** Bets each new wallet is funded for. */
const BETS_PER_WALLET = 3;
/** Enough for hundreds of approve+stake pairs at Somnia Shannon testnet prices. */
const GAS_PER_WALLET_ETH = 0.004;
/** Left with the oracle, which still has to settle every market it opened. */
const FUNDER_RESERVE_ETH = 0.35;
/** A source wallet keeps this much USDC to keep betting with. */
const SOURCE_FLOAT_USDC = 8;

const DRY = process.env.DRY_RUN === "1";
const argv = process.argv.slice(2);
const flag = (name: string, fallback: number): number => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] ? Number(argv[at + 1]) : fallback;
};
const WANT_WALLETS = flag("wallets", 40);
const WANT_MARKETS = flag("markets", 10);
const BET_ONLY = argv.includes("--bet-only");

const client = createSomniaPublicClient();
const CONTRACT = getContractAddress();

const usdcOf = (address: `0x${string}`) =>
  client.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [address] }) as Promise<bigint>;

async function confirm(hash: `0x${string}`): Promise<void> {
  await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
}

/* ── Wallets ──────────────────────────────────────────────────────────────── */

interface Traction {
  index: number;
  key: `0x${string}`;
  address: `0x${string}`;
}

function readWallets(): Traction[] {
  if (!existsSync(WALLET_FILE)) return [];
  return readFileSync(WALLET_FILE, "utf8")
    .split(/\r?\n/)
    .map((line) => line.match(/^TRACTION_(\d+)_PRIVATE_KEY=(0x[0-9a-fA-F]{64})/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => ({
      index: Number(m[1]),
      key: m[2] as `0x${string}`,
      address: privateKeyToAccount(m[2] as `0x${string}`).address,
    }));
}

function ensureWallets(target: number): Traction[] {
  const existing = readWallets();
  if (existing.length >= target) {
    console.log(`${existing.length} traction wallets on file; none created.`);
    return existing;
  }
  const wallets = [...existing];
  const lines: string[] = [];
  for (let i = existing.length; i < target; i++) {
    const key = generatePrivateKey();
    wallets.push({ index: i, key, address: privateKeyToAccount(key).address });
    lines.push(`TRACTION_${i}_PRIVATE_KEY=${key}`);
  }
  if (DRY) {
    console.log(`would create ${lines.length} wallets (dry run, nothing written)`);
    return wallets;
  }
  // Append, never rewrite: truncating this file loses the keys to whatever float
  // the older wallets are holding.
  appendFileSync(WALLET_FILE, (existing.length === 0 ? "# Mimir traction wallets — keys only, gitignored.\n" : "") + lines.join("\n") + "\n", "utf8");
  console.log(`created ${lines.length} wallets → ${WALLET_FILE} (now ${wallets.length})`);
  return wallets;
}

/* ── Funding ──────────────────────────────────────────────────────────────── */

/** Wallets holding the float, richest first, so the biggest pots are tapped first. */
async function sourceWallets(): Promise<{ label: string; wallet: AgentWallet; usdc: bigint }[]> {
  const envs: { label: string; env: string }[] = [
    { label: "market-creator", env: "CREATOR_PRIVATE_KEY" },
    ...COUNCIL_PERSONAS.map((p) => ({ label: `council:${p.slug}`, env: personaPrivateKeyEnv(p) })),
    ...PHILOSOPHER_PERSONAS.map((p) => ({ label: `philosopher:${p.slug}`, env: philosopherPrivateKeyEnv(p.slug) })),
  ];
  const out: { label: string; wallet: AgentWallet; usdc: bigint }[] = [];
  for (const { label, env } of envs) {
    if (!process.env[env]) continue;
    const wallet = loadAgentWallet(env);
    out.push({ label, wallet, usdc: await usdcOf(wallet.address) });
  }
  return out.sort((a, b) => (b.usdc > a.usdc ? 1 : -1));
}

async function fundGas(wallets: Traction[]): Promise<void> {
  const funder = loadAgentWallet("ORACLE_PRIVATE_KEY");
  const target = parseEther(String(GAS_PER_WALLET_ETH));
  const balances = await Promise.all(wallets.map((w) => client.getBalance({ address: w.address })));
  const needy = wallets.filter((_, i) => balances[i] < target / 2n);

  const available = (await client.getBalance({ address: funder.address })) - parseEther(String(FUNDER_RESERVE_ETH));
  const total = target * BigInt(needy.length);
  console.log(`\nGas: ${needy.length} wallets need topping up (${formatEther(total)} ETH); funder can spend ${formatEther(available)}.`);
  if (total > available) throw new Error(`not enough ETH: need ${formatEther(total)}, can spend ${formatEther(available)}`);
  if (DRY) return;

  for (const w of needy) {
    const hash = await funder.client.sendTransaction({ account: funder.account, to: w.address, value: target, chain: null });
    await confirm(hash);
    process.stdout.write(".");
  }
  if (needy.length) console.log(" done");
}

async function fundUsdc(wallets: Traction[]): Promise<void> {
  const per = usdcToUnits(BET_USDC * BETS_PER_WALLET);
  const balances = await Promise.all(wallets.map((w) => usdcOf(w.address)));
  const needy = wallets.filter((_, i) => balances[i] < usdcToUnits(BET_USDC));

  const sources = await sourceWallets();
  const float = usdcToUnits(SOURCE_FLOAT_USDC);
  const spendable = sources.map((s) => ({ ...s, give: s.usdc > float ? s.usdc - float : 0n }));
  const pool = spendable.reduce((sum, s) => sum + s.give, 0n);

  console.log(`\nUSDC: ${needy.length} wallets to fund at ${BET_USDC * BETS_PER_WALLET} each ` +
    `(${unitsToUsdc(per * BigInt(needy.length)).toFixed(2)} needed); ` +
    `${unitsToUsdc(pool).toFixed(2)} spendable across ${spendable.filter((s) => s.give > 0n).length} source wallets.`);

  let si = 0;
  for (const w of needy) {
    // Walk the sources in order, taking what each can spare. A wallet that only
    // covers part of the target still gets funded — 2 USDC is one bet, and one
    // bet is the unit that matters here.
    let remaining = per;
    while (remaining > 0n && si < spendable.length) {
      const source = spendable[si];
      if (source.give < usdcToUnits(BET_USDC)) { si++; continue; }
      const amount = source.give < remaining ? source.give : remaining;
      if (DRY) {
        console.log(`  would send ${unitsToUsdc(amount).toFixed(2)} ${source.label} → ${w.address.slice(0, 10)}`);
      } else {
        const hash = await source.wallet.client.writeContract({
          account: source.wallet.account, address: USDC_ADDRESS, abi: ERC20_ABI,
          functionName: "transfer", args: [w.address, amount], chain: null,
        });
        await confirm(hash);
        process.stdout.write(".");
      }
      source.give -= amount;
      remaining -= amount;
    }
    if (remaining === per) { console.log("\n  sources exhausted; remaining wallets left unfunded."); break; }
  }
  console.log(DRY ? "" : " done");
}

/* ── Markets ──────────────────────────────────────────────────────────────── */

interface Draft {
  question: string;
  creatorPosition: string;
  counterPosition: string;
  resolutionUrl: string;
  category: string;
  marketType: string;
  settlementRule: string;
  deadline: number;
}

/**
 * Claims built from the same live sources the market-creator uses, without the
 * LLM in the way: the threshold is derived from the forecast itself, so the
 * question is genuinely close rather than decorative.
 */
async function draftMarkets(count: number): Promise<Draft[]> {
  const drafts: Draft[] = [];
  const now = Date.now();

  try {
    const { events } = await fetchWeatherEvents();
    for (const event of events) {
      // Round to the nearest degree: a threshold sitting exactly on the forecast
      // is the coin-flip, which is the only interesting version of this market.
      const line = Math.round(event.forecastHighC);
      const deadline = Math.floor(new Date(`${event.targetDate}T23:00:00Z`).getTime() / 1000);
      if (deadline * 1000 < now + 3 * 3600_000) continue;
      drafts.push({
        question: `Will the daily high in ${event.city} reach ${line}°C or more on ${event.targetDate}?`,
        creatorPosition: `Yes — ${event.city} hits ${line}°C or higher`,
        counterPosition: `No — it stays below ${line}°C`,
        resolutionUrl: event.resolutionUrl,
        category: "weather",
        marketType: "threshold",
        settlementRule: `Resolve YES if daily temperature_2m_max for ${event.targetDate} at the given coordinates is >= ${line}. Source: Open-Meteo.`,
        deadline,
      });
    }
  } catch (err) {
    console.warn("weather source unavailable:", err instanceof Error ? err.message : err);
  }

  try {
    const { events } = await fetchLaunchEvents();
    for (const event of events) {
      // Deadline at the window, not after it: the trade is whether it goes on time.
      const deadline = Math.floor(event.windowStartMs / 1000);
      if (event.windowStartMs < now + 6 * 3600_000) continue;
      drafts.push({
        question: `Will ${event.name} still be scheduled to launch by ${new Date(event.windowStartMs).toISOString().slice(0, 16)}Z?`,
        creatorPosition: "Yes — the window holds",
        counterPosition: "No — it slips past the window",
        resolutionUrl: event.resolutionUrl,
        category: "space",
        marketType: "binary",
        settlementRule: `Resolve YES if the launch record still shows a window start at or before the deadline. Source: Launch Library 2 record ${event.id}.`,
        deadline,
      });
    }
  } catch (err) {
    console.warn("launch source unavailable:", err instanceof Error ? err.message : err);
  }

  return drafts.slice(0, count);
}

async function createMarkets(count: number): Promise<void> {
  if (count <= 0) return;
  const creator = loadAgentWallet("CREATOR_PRIVATE_KEY");
  const feeRecipient = (process.env.PLATFORM_FEE_RECIPIENT?.trim() || creator.address) as `0x${string}`;
  const drafts = await draftMarkets(count);
  const stake = usdcToUnits(BET_USDC);

  const budget = await usdcOf(creator.address);
  const affordable = Math.min(drafts.length, Number(budget / stake));
  console.log(`\nMarkets: ${drafts.length} drafted from live sources, creator can fund ${affordable}.`);

  for (const draft of drafts.slice(0, affordable)) {
    if (DRY) { console.log(`  would open: ${draft.question}`); continue; }
    try {
      const hash = await agentContractWrite({
        wallet: creator,
        contractAddress: CONTRACT,
        abi: MIMIR_ABI,
        functionName: "createClaim",
        args: [[
          draft.question, draft.creatorPosition, draft.counterPosition, draft.resolutionUrl,
          BigInt(draft.deadline), stake, draft.category, BigInt(0),
          draft.marketType, "pool", BigInt(0), "", draft.settlementRule,
          BigInt(100), false, "", `0x${"00".repeat(32)}`, feeRecipient,
        ]],
        amountUsdc: String(BET_USDC),
      });
      await confirm(hash);
      console.log(`  opened: ${draft.question.slice(0, 62)}…`);
    } catch (err) {
      console.warn(`  failed: ${draft.question.slice(0, 48)} — ${err instanceof Error ? err.message.split("\n")[0] : err}`);
    }
  }
}

/* ── Betting ──────────────────────────────────────────────────────────────── */

interface Bettable {
  id: bigint;
  creator: `0x${string}`;
  question: string;
  freeSlots: number;
}

async function bettableClaims(): Promise<Bettable[]> {
  const count = await client.readContract({ address: CONTRACT, abi: MIMIR_ABI, functionName: "claimCount" }) as bigint;
  const now = Math.floor(Date.now() / 1000);
  const out: Bettable[] = [];
  for (let id = 1n; id <= count; id++) {
    const claim = await client.readContract({ address: CONTRACT, abi: MIMIR_ABI, functionName: "getClaim", args: [id] }) as readonly unknown[];
    const state = Number(claim[9]);
    const deadline = Number(claim[8]);
    const challengers = Number(claim[15]);
    // The contract's own numbering: ST_OPEN = 0, ST_ACTIVE = 1, ST_RESOLVED = 2,
    // ST_CANCELLED = 3. Reading these one off — accepting 1 and 2 — silently skips
    // every freshly created market and offers to bet on settled ones instead.
    if (state !== ST_OPEN && state !== ST_ACTIVE) continue;
    // 60s is the contract's own challenge lock; leave margin so a slow receipt
    // does not land on the wrong side of it.
    if (deadline <= now + 180) continue;
    const config = await client.readContract({ address: CONTRACT, abi: MIMIR_ABI, functionName: "getClaimMarketConfig", args: [id] }) as readonly unknown[];
    const maxChallengers = Number(config[5]);
    if (challengers >= maxChallengers) continue;
    out.push({
      id,
      creator: claim[0] as `0x${string}`,
      question: String(claim[1]),
      freeSlots: maxChallengers - challengers,
    });
  }
  return out;
}

async function placeBets(wallets: Traction[]): Promise<void> {
  const claims = await bettableClaims();
  console.log(`\nBetting: ${claims.length} bettable claims.`);
  if (claims.length === 0) {
    console.log("Nothing open far enough from its deadline. Open markets first.");
    return;
  }

  // Existing agent wallets bet too — they hold most of the float, and leaving them
  // idle would cap the run at whatever the new wallets were given.
  const sources = await sourceWallets();
  const bettors: { label: string; wallet: AgentWallet }[] = [
    ...wallets.map((w) => ({
      label: `traction-${w.index}`,
      wallet: {
        account: privateKeyToAccount(w.key),
        client: createSomniaWalletClientWithKey(w.key),
        address: w.address,
      } as AgentWallet,
    })),
    ...sources.map((s) => ({ label: s.label, wallet: s.wallet })),
  ];

  const stake = usdcToUnits(BET_USDC);
  let placed = 0, skipped = 0, failed = 0;

  for (const [seat, bettor] of bettors.entries()) {
    let budget = await usdcOf(bettor.wallet.address);
    if (budget < stake) { skipped++; continue; }
    if ((await client.getBalance({ address: bettor.wallet.address })) === 0n) { skipped++; continue; }

    // Start each bettor at a different claim. Walking the same order every time
    // means everyone spends their budget on the lowest ids, which left ten fresh
    // markets at zero challengers while one collected sixty.
    const rotated = claims.slice(seat % claims.length).concat(claims.slice(0, seat % claims.length));
    for (const claim of rotated) {
      if (budget < stake) break;
      if (claim.freeSlots <= 0) continue;
      // The contract rejects both of these; checking here saves a reverted tx.
      if (claim.creator.toLowerCase() === bettor.wallet.address.toLowerCase()) continue;
      const already = await client.readContract({
        address: CONTRACT, abi: MIMIR_ABI, functionName: "hasChallenged", args: [claim.id, bettor.wallet.address],
      }).catch(() => false) as boolean;
      if (already) continue;

      if (DRY) {
        console.log(`  would bet ${BET_USDC} ${bettor.label} → #${claim.id}`);
        placed++; budget -= stake; claim.freeSlots--;
        continue;
      }
      try {
        const hash = await agentContractWrite({
          wallet: bettor.wallet,
          contractAddress: CONTRACT,
          abi: MIMIR_ABI,
          functionName: "challengeClaim",
          args: [claim.id, stake, ""],
          amountUsdc: String(BET_USDC),
        });
        await confirm(hash);
        placed++; budget -= stake; claim.freeSlots--;
        process.stdout.write(".");
      } catch (err) {
        failed++;
        // viem puts "reverted with the following reason:" on its first line and
        // the reason on the next, so logging line one labels every failure
        // identically and diagnoses none of them.
        const raw = err instanceof Error ? err.message : String(err);
        const message = /reason:\s*\n\s*(.+)/.exec(raw)?.[1]?.trim() ?? raw.split("\n")[0];
        // Out of USDC: stop this wallet instead of offering it every remaining
        // claim in turn. The local budget can outrun the real balance — a stake
        // whose receipt timed out still moved the money — so the chain's refusal
        // is the authority on when a wallet is finished.
        if (/exceeds balance|stake too small/.test(message)) break;
        if (/already challenged|self-challenge|full|window closed/.test(message)) continue;
        console.warn(`
  ${bettor.label} → #${claim.id}: ${message.slice(0, 110)}`);
      }
    }
  }
  console.log(`\n\nplaced ${placed} bets of ${BET_USDC} USDC` +
    `  (${skipped} wallets had nothing to stake, ${failed} calls rejected)`);
}

/* ── Main ─────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  console.log(`Mimir traction run${DRY ? "  (dry run)" : ""}`);
  console.log(`contract ${CONTRACT}   bet size ${BET_USDC} USDC (contract minimum)\n`);

  const wallets = BET_ONLY ? readWallets() : ensureWallets(WANT_WALLETS);

  if (!BET_ONLY) {
    // Markets before funding, deliberately. The creator is also the largest USDC
    // holder, so funding first drains the very wallet that has to stake 2 USDC per
    // market — and then there is nothing to bet into.
    await createMarkets(WANT_MARKETS);
    await fundGas(wallets);
    await fundUsdc(wallets);
  }
  await placeBets(wallets);

  const holders = [...wallets.map((w) => w.address), ...(await sourceWallets()).map((s) => s.wallet.address)];
  const totals = await Promise.all(holders.map(usdcOf));
  const usdc = totals.reduce((sum, value) => sum + value, 0n);
  console.log(`\nFloat still liquid: ${unitsToUsdc(usdc).toFixed(2)} USDC across ${holders.length} wallets ` +
    `(~${Math.floor(Number(unitsToUsdc(usdc)) / BET_USDC)} more bets before settlements return capital).`);
  console.log(`
Somnia Explorer: https://sepolia.explorer.somnia.network/address/${CONTRACT}`);
}

main().catch((err) => {
  console.error("\nseed-traction failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
