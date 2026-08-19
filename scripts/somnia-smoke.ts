/**
 * First-contact smoke test for the Somnia / DreamDEX stack: build the exchange,
 * list live markets, narrow to binary markets and print symbols.
 *
 * Run: npx tsx scripts/somnia-smoke.ts
 * Needs: network access to the DreamDEX indexer + Somnia testnet RPC/WS.
 */
import {
  createExchange,
  upSymbolOf,
  isBinaryMarket,
} from "../lib/dreamdex";

async function main() {
  const exchange = createExchange();
  try {
    const markets = Object.values(await exchange.loadMarkets(true));
    console.log(`markets loaded: ${markets.length}`);

    const binary = markets.filter((m) => isBinaryMarket(m.info)).slice(0, 8);
    console.log(`binary markets (first ${binary.length}):`);
    for (const m of binary) {
      const up = upSymbolOf(m);
      const { marketId, status, expiry } = m.info as {
        marketId?: string;
        status?: number;
        expiry?: string;
      };
      console.log(`  ${m.symbol ?? "(no symbol)"}  marketId=${marketId ?? "?"}  status=${status ?? "?"}  expiry=${expiry ?? "?"}  up=${up ?? "?"}`);
    }
  } finally {
    await exchange.close();
  }
}

main().catch((error) => {
  console.error("smoke failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});