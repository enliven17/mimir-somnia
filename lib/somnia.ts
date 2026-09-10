/**
 * Somnia (Shannon testnet) chain configuration.
 *
 * Chain ID: 50312 (0xC48C) — CAIP-2 `eip155:50312`
 * Native currency: STT (18 decimals) — gas only
 * Market stakes / payouts: the DreamDEX Event Contract collateral
 *   (faucet USDC, 6 decimals, on testnet) — see lib/dreamdex.ts
 *
 * The chain definitions come from @somnia-chain/markets-sdk/chains so they stay
 * in lockstep with the SDK the trading layer is built on (they ship the Somnia
 * WebSocket endpoint the live tail needs).
 */
import {
  createPublicClient,
  http,
  formatEther,
  type PublicClient,
} from "viem";
import {
  somniaShannon,
  somniaMainnet,
  getSomniaChain,
} from "@somnia-chain/markets-sdk/chains";

/** The network Mimir trades on. Swap this to `somniaMainnet` for a prod release. */
export const CHAIN = somniaShannon;

export { somniaShannon, somniaMainnet, getSomniaChain };

/** Canonical explorer for the active Somnia network. */
export const SOMNIA_EXPLORER_URL = CHAIN.blockExplorers.default.url;

/** CAIP-2 network identifier — the id x402 / EIP-3009 and the analytics envelope speak. */
export const SOMNIA_CAIP2 = `eip155:${CHAIN.id}` as const;

// ── RPC endpoint ──────────────────────────────────────────────────────────────
let warnedPublicRpc = false;

export function getSomniaRpcUrl(): string {
  const configured =
    process.env.NEXT_PUBLIC_SOMNIA_RPC_URL?.trim() ||
    (typeof window === "undefined" ? process.env.SOMNIA_RPC_URL?.trim() : undefined);
  if (configured) return configured;

  if (process.env.NODE_ENV === "production" && !warnedPublicRpc) {
    warnedPublicRpc = true;
    console.warn(
      "[somnia] falling back to the public Somnia testnet RPC in production — set SOMNIA_RPC_URL to a provider endpoint.",
    );
  }
  return CHAIN.rpcUrls.default.http[0];
}

/** WebSocket endpoint for the live tail / on-chain subscriptions. */
export function getSomniaWsUrl(): string {
  const configured = process.env.SOMNIA_WS_URL?.trim();
  if (configured) return configured;
  const ws = CHAIN.rpcUrls.default.webSocket?.[0];
  if (ws) return ws;
  return getSomniaRpcUrl().replace(/^http/, "ws");
}

/** Envio/Hasura GraphQL endpoint backing the SDK's market registry reads. */
export function getDreamdexIndexerUrl(): string {
  const configured = process.env.DREAMDEX_INDEXER_URL?.trim() || process.env.SOMNIA_INDEXER_URL?.trim();
  if (configured) return configured;
  // The SDK's published testnet indexer; override for a mainnet release.
  return "https://dev.smk.somnia.host/v1/graphql";
}

// ── Log scanning ──────────────────────────────────────────────────────────────
// The Somnia testnet RPC rejects eth_getLogs ranges wider than 1000 blocks
// ("block range exceeds 1000"), and a chunk spans start..start+CHUNK inclusive,
// so 999 is the widest request it accepts. Tune via SOMNIA_LOG_CHUNK.
function envInt(key: string, fallback: number): number {
  const raw = Number(
    (typeof process !== "undefined" && process.env?.[key]) || String(fallback),
  );
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export const SOMNIA_LOG_CHUNK = BigInt(envInt("SOMNIA_LOG_CHUNK", 999));
export const SOMNIA_LOG_CONCURRENCY = envInt("SOMNIA_LOG_CONCURRENCY", 8);

export async function paginatedGetLogs(
  client: PublicClient,
  params: Omit<Parameters<PublicClient["getLogs"]>[0], "fromBlock" | "toBlock">,
  fromBlock: bigint,
  toBlock?: bigint,
): Promise<any[]> {
  const end = toBlock ?? (await client.getBlockNumber());
  const ranges: Array<{ from: bigint; to: bigint }> = [];
  for (let start = fromBlock; start <= end; ) {
    const stop = start + SOMNIA_LOG_CHUNK > end ? end : start + SOMNIA_LOG_CHUNK;
    ranges.push({ from: start, to: stop });
    start = stop + 1n;
  }
  const pages: any[][] = new Array(ranges.length);
  let next = 0;
  let unavailable = 0;
  let lastError: unknown = null;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= ranges.length) return;
      const { from, to } = ranges[index];
      try {
        pages[index] = await client.getLogs({
          ...(params as any),
          fromBlock: from,
          toBlock: to,
        });
      } catch (error) {
        pages[index] = [];
        unavailable++;
        lastError = error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(SOMNIA_LOG_CONCURRENCY, ranges.length) }, worker),
  );
  if (unavailable === ranges.length && ranges.length > 0) {
    throw lastError instanceof Error ? lastError : new Error("eth_getLogs failed for every block range");
  }
  return pages.flat();
}

export function getExplorerTxUrl(txHash: string): string {
  return `${SOMNIA_EXPLORER_URL}/tx/${txHash}`;
}

export function getExplorerAddressUrl(address: string): string {
  return `${SOMNIA_EXPLORER_URL}/address/${address}`;
}

// ── viem clients ──────────────────────────────────────────────────────────────
export const RPC_BATCH_SIZE = envInt("SOMNIA_RPC_BATCH_SIZE", 10);

const HTTP_OPTS = {
  batch: { batchSize: RPC_BATCH_SIZE, wait: 16 },
  retryCount: 2,
  retryDelay: 300,
  timeout: 10_000,
};

export function createSomniaPublicClient(): PublicClient {
  return createPublicClient({
    chain: CHAIN,
    transport: http(getSomniaRpcUrl(), HTTP_OPTS),
  }) as PublicClient;
}

// ── Gas unit helpers (native STT, 18 decimals) ───────────────────────────────
export function weiToSomni(wei: bigint | number): number {
  return Number(formatEther(BigInt(wei)));
}

export function formatSomniAmount(wei: bigint | number, decimals = 4): string {
  return `${weiToSomni(wei).toFixed(decimals)} STT`;
}
