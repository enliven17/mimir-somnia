/**
 * Fan real trading across many wallets on the DreamDEX venue.
 *
 *   DRY_RUN=1 npx tsx --env-file-if-exists=.env.local scripts/seed-venue-traction.ts
 *   npx tsx --env-file-if-exists=.env.local scripts/seed-venue-traction.ts
 *   ... scripts/seed-venue-traction.ts --wallets 12 --bets 2
 *   ... scripts/seed-venue-traction.ts --bet-only       (skip creating and funding)
 *
 * Its sibling, seed-traction.ts, does the same job against the Mimir contract's
 * VS claims. This one targets the venue the agents actually trade, so the volume
 * it produces is the volume the site reports.
 *
 * ── What bounds this ────────────────────────────────────────────────────────
 *
 * Collateral is a faucet token: it can be received, never minted here, so the
 * float is whatever the creator wallet already holds. A buy is not spent but
 * converted — collateral becomes outcome shares, and settlement turns the
 * winning ones back into collateral. Capacity therefore returns as markets
 * resolve, and re-running picks the freed float back up.
 *
 * Short-dated markets are skipped. The venue lists binaries that settle within
 * the minute, and a position opened into one is a coin flip with a fee, not
 * traction.
 *
 * Wallet keys are appended to traction-wallets.env (gitignored) and reused next
 * run. That file IS the money: generating a fresh set each time would strand the
 * float in addresses nothing can sign for.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";

import { formatEther, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  createSomniaPublicClient,
  createSomniaWalletClientWithKey,
  somniaShannon,
  weiToStt,
} from "../lib/chain";
import { COLLATERAL } from "../lib/dreamdex";
import { loadDreamDexMarkets, withDreamDexSigner } from "../lib/dreamdex-market";
import { ERC20_ABI, unitsToUsdc, usdcToUnits } from "../lib/usdc";
import { recordVenuePosition } from "../lib/db";

const WALLET_FILE = "traction-wallets.env";
const COLLATERAL_TOKEN = COLLATERAL as `0x${string}`;

/** Collateral committed per position. */
const BET_USDC = 1;
/** Positions each wallet opens per run. */
const BETS_PER_WALLET = 2;
/** Hundreds of approve+order pairs at Shannon prices. */
const GAS_PER_WALLET_STT = 0.02;
/** The funder still has to keep working after this. */
const FUNDER_RESERVE_STT = 0.3;
/** Refuse markets that settle sooner than this — see the header. */
const MIN_HEADROOM_SECONDS = 1800;
/** Taker margin over the best ask, before snapping to the tick grid. */
const SLIPPAGE = 0.03;

const DRY = process.env.DRY_RUN === "1";
const argv = process.argv.slice(2);
const BET_ONLY = argv.includes("--bet-only");

function numberArg(flag: string, fallback: number): number {
  const index = argv.indexOf(flag);
  if (index === -1) return fallback;
  const value = Number(argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const WALLET_COUNT = numberArg("--wallets", 10);
const BETS = numberArg("--bets", BETS_PER_WALLET);

interface TractionWallet {
  privateKey: `0x${string}`;
  address: `0x${string}`;
}

/** Reuse what exists, top up to the requested count, never regenerate. */
function loadOrCreateWallets(count: number): TractionWallet[] {
  const existing: TractionWallet[] = [];
  if (existsSync(WALLET_FILE)) {
    for (const line of readFileSync(WALLET_FILE, "utf8").split(/\r?\n/)) {
      const match = line.match(/^TRACTION_WALLET_\d+=(0x[0-9a-fA-F]{64})\s*$/);
      if (!match) continue;
      const privateKey = match[1] as `0x${string}`;
      existing.push({ privateKey, address: privateKeyToAccount(privateKey).address });
    }
  }
  if (existing.length >= count) return existing.slice(0, count);

  const created: TractionWallet[] = [];
  for (let i = existing.length; i < count; i++) {
    const privateKey = generatePrivateKey();
    created.push({ privateKey, address: privateKeyToAccount(privateKey).address });
  }
  if (!DRY && created.length > 0) {
    const lines = created
      .map((wallet, index) => `TRACTION_WALLET_${existing.length + index}=${wallet.privateKey}`)
      .join("\n");
    appendFileSync(WALLET_FILE, `${lines}\n`, "utf8");
    console.log(`  wrote ${created.length} new key(s) to ${WALLET_FILE}`);
  }
  return [...existing, ...created];
}

function funderKey(): `0x${string}` {
  const name = process.env.TRACTION_FUNDER_ENV?.trim() || "CREATOR_PRIVATE_KEY";
  const key = process.env[name]?.trim();
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(`${name} is unset or malformed — point TRACTION_FUNDER_ENV at a funded key`);
  }
  return key as `0x${string}`;
}

async function main(): Promise<void> {
  const publicClient = createSomniaPublicClient();
  const key = funderKey();
  const funder = privateKeyToAccount(key);
  const wallet = createSomniaWalletClientWithKey(key);

  const wallets = loadOrCreateWallets(WALLET_COUNT);
  const needGas = parseEther(String(GAS_PER_WALLET_STT));
  const needCollateral = usdcToUnits(BET_USDC * BETS);

  console.log(`Venue traction${DRY ? " (DRY RUN)" : ""}`);
  console.log(`  chain    ${somniaShannon.name} (${somniaShannon.id})`);
  console.log(`  funder   ${funder.address}`);
  console.log(`  wallets  ${wallets.length} · ${BETS} position(s) each at ${BET_USDC} collateral`);

  const [funderGas, funderCollateral] = await Promise.all([
    publicClient.getBalance({ address: funder.address }),
    publicClient.readContract({
      address: COLLATERAL_TOKEN, abi: ERC20_ABI,
      functionName: "balanceOf", args: [funder.address],
    }) as Promise<bigint>,
  ]);
  console.log(`  float    ${weiToStt(funderGas).toFixed(4)} STT · ${unitsToUsdc(funderCollateral).toFixed(2)} collateral`);

  // ── Fund ──────────────────────────────────────────────────────────────────
  if (!BET_ONLY) {
    const reserve = parseEther(String(FUNDER_RESERVE_STT));
    let gasLeft = funderGas > reserve ? funderGas - reserve : 0n;
    let collateralLeft = funderCollateral;

    for (const target of wallets) {
      const [hasGas, hasCollateral] = await Promise.all([
        publicClient.getBalance({ address: target.address }),
        publicClient.readContract({
          address: COLLATERAL_TOKEN, abi: ERC20_ABI,
          functionName: "balanceOf", args: [target.address],
        }) as Promise<bigint>,
      ]);

      const gasGap = hasGas >= needGas ? 0n : needGas - hasGas;
      const collateralGap = hasCollateral >= needCollateral ? 0n : needCollateral - hasCollateral;
      if (gasGap === 0n && collateralGap === 0n) continue;

      if (gasGap > gasLeft || collateralGap > collateralLeft) {
        console.log(`  float exhausted at ${target.address} — funding stops here`);
        break;
      }

      console.log(
        `  fund ${target.address} +${formatEther(gasGap)} STT +${unitsToUsdc(collateralGap).toFixed(2)} collateral`,
      );
      if (DRY) {
        gasLeft -= gasGap;
        collateralLeft -= collateralGap;
        continue;
      }

      if (gasGap > 0n) {
        const hash = await wallet.sendTransaction({
          account: funder, chain: somniaShannon, to: target.address, value: gasGap,
        });
        await publicClient.waitForTransactionReceipt({ hash });
        gasLeft -= gasGap;
      }
      if (collateralGap > 0n) {
        const hash = await wallet.writeContract({
          account: funder, chain: somniaShannon, address: COLLATERAL_TOKEN,
          abi: ERC20_ABI, functionName: "transfer", args: [target.address, collateralGap],
        });
        await publicClient.waitForTransactionReceipt({ hash });
        collateralLeft -= collateralGap;
      }
    }
  }

  // ── Trade ─────────────────────────────────────────────────────────────────
  const nowSeconds = Math.floor(Date.now() / 1000);
  const markets = (await loadDreamDexMarkets({ includeInactive: false, reload: true }))
    .filter((market) => market.status === "Trading" && market.expiry > nowSeconds + MIN_HEADROOM_SECONDS)
    .sort((a, b) => b.volume - a.volume);

  console.log(`  markets  ${markets.length} with enough life left to trade`);
  if (markets.length === 0) {
    console.log("Nothing tradable right now — the venue's live markets all settle too soon.");
    return;
  }

  let opened = 0;
  let failed = 0;

  for (const [walletIndex, target] of wallets.entries()) {
    const collateral = (await publicClient.readContract({
      address: COLLATERAL_TOKEN, abi: ERC20_ABI,
      functionName: "balanceOf", args: [target.address],
    })) as bigint;
    if (unitsToUsdc(collateral) < BET_USDC) {
      console.log(`  ${target.address} has no collateral, skipping`);
      continue;
    }

    try {
      await withDreamDexSigner(target.privateKey, async (exchange) => {
        for (let bet = 0; bet < BETS; bet++) {
          // Spread the wallets across markets and sides rather than piling every
          // one onto the same book: a single crowded side is not traction, it is
          // one trade repeated.
          const market = markets[(walletIndex + bet) % markets.length];
          const outcome: "YES" | "NO" = (walletIndex + bet) % 2 === 0 ? "YES" : "NO";
          const symbol = outcome === "YES" ? market.yesSymbol : market.noSymbol;

          const book = await exchange.fetchOrderBook(symbol, 5);
          const bestAsk = book.asks[0]?.[0];
          if (!bestAsk || bestAsk <= 0) {
            console.log(`  ${market.symbol} ${outcome}: no ask, skipping`);
            continue;
          }

          // Same grids the workers respect: a price off the tick or a size off
          // the lot is rejected by the pool before it reaches the book.
          const price = exchange.priceToPrecision(symbol, Math.min(bestAsk * (1 + SLIPPAGE), 0.999));
          const quantity = exchange.amountToPrecision(symbol, BET_USDC / price);
          if (!(quantity > 0)) {
            console.log(`  ${market.symbol} ${outcome}: ${BET_USDC} is under one lot at ${price}`);
            continue;
          }

          if (DRY) {
            console.log(`  DRY ${target.address.slice(0, 10)} would buy ${outcome} ${market.symbol} ${quantity} @ ${price}`);
            opened += 1;
            continue;
          }

          const order = await exchange.createOrder(symbol, "limit", "buy", quantity, price, {
            timeInForce: "IOC",
          });
          const txHash = order.txHash ?? order.id ?? "";
          console.log(`  ${target.address.slice(0, 10)} bought ${outcome} ${market.symbol} ${quantity} @ ${price} · ${txHash}`);
          opened += 1;

          if (txHash) {
            await recordVenuePosition({
              txHash,
              agentId: `traction-${walletIndex}`,
              track: "traction",
              marketRef: market.symbol,
              question: market.question,
              outcome,
              stakeUsdc: BET_USDC,
              quantity,
              price,
              confidence: 0,
              rationale: "Seeded liquidity: spread across books to exercise the venue end to end.",
              createdAt: Date.now(),
            }).catch(() => undefined);
          }
        }
      });
    } catch (error) {
      failed += 1;
      console.warn(
        `  ${target.address} failed:`,
        error instanceof Error ? error.message.slice(0, 140) : error,
      );
    }
  }

  console.log(`\n${DRY ? "Would open" : "Opened"} ${opened} position(s)${failed > 0 ? ` · ${failed} wallet(s) failed` : ""}.`);
}

main().catch((error) => {
  console.error("venue traction failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
