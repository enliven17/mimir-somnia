/**
 * Somnia Shannon testnet configuration
 * Chain ID: 50312 (0xc488) — CAIP-2 `eip155:50312`
 * Native currency: STT (18 decimals) — gas only
 * Market stakes / payouts / x402 payments: USDC (6 decimals) — see lib/usdc.ts
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  custom,
  formatEther,
  type PublicClient,
  type WalletClient,
} from "viem";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { privateKeyToAccount } from "viem/accounts";

export { somniaShannon };

/** Canonical explorer for Somnia Shannon testnet (viem's own chain definition). */
export const SOMNIA_EXPLORER_URL = somniaShannon.blockExplorers.default.url;

/** CAIP-2 network identifier — the id x402 speaks. */
export const SOMNIA_CAIP2 = `eip155:${somniaShannon.id}` as const;

// ── RPC endpoint ──────────────────────────────────────────────────────────────
// The public testnet endpoint is suitable for local development. Deployments
// should set SOMNIA_RPC_URL / NEXT_PUBLIC_SOMNIA_RPC_URL to a provider endpoint.
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
  return somniaShannon.rpcUrls.default.http[0];
}

export function getContractAddress(): `0x${string}` {
  // Trimmed: a value pasted into a dashboard, or read from a CRLF .env by a shell
  // that drops the newline but keeps the carriage return, arrives with invisible
  // whitespace. viem then rejects the address as malformed and every contract read
  // fails, naming a string that looks perfectly correct in the logs.
  const addr =
    process.env.NEXT_PUBLIC_CONTRACT_ADDRESS?.trim() ||
    "0x0000000000000000000000000000000000000000";
  return addr as `0x${string}`;
}

/** False when NEXT_PUBLIC_CONTRACT_ADDRESS is unset / zero — skip chain reads. */
export function isContractConfigured(): boolean {
  const addr = getContractAddress().toLowerCase();
  return addr !== "0x0000000000000000000000000000000000000000";
}

// ── Log scanning ──────────────────────────────────────────────────────────────
// The Somnia testnet RPC rejects eth_getLogs ranges wider than 1000 blocks
// ("block range exceeds 1000"), and a chunk spans start..start+CHUNK inclusive,
// so 999 is the widest request it accepts. Override with SOMNIA_LOG_CHUNK.
function envInt(key: string, fallback: number): number {
  const raw = Number(
    (typeof process !== "undefined" && process.env?.[key]) || String(fallback),
  );
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export const SOMNIA_LOG_CHUNK = BigInt(envInt("SOMNIA_LOG_CHUNK", 999));

/** How many eth_getLogs chunks stay in flight. */
export const SOMNIA_LOG_CONCURRENCY = envInt("SOMNIA_LOG_CONCURRENCY", 8);

export function getDeployBlock(): bigint {
  const raw = process.env.NEXT_PUBLIC_DEPLOY_BLOCK;
  if (raw && raw.trim().length > 0) {
    try { return BigInt(raw); } catch { /* fall through */ }
  }
  return 0n;
}

/**
 * Chunked, concurrent eth_getLogs from `fromBlock`. Results stay in range order
 * so callers still see logs oldest-first. A single failing chunk is dropped
 * rather than rejecting the whole scan (one flaky range must not blank the
 * feed), but every chunk failing surfaces the error.
 */
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
    throw lastError instanceof Error
      ? lastError
      : new Error("eth_getLogs failed for every block range");
  }
  if (unavailable > 0) {
    console.warn(
      `[somnia] getLogs: ${unavailable}/${ranges.length} block ranges failed; serving the readable remainder.`,
    );
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
// viem's JSON-RPC batch transport bundles all eth_call requests that fire within
// `wait` ms into one POST body, which drops the request count by ~100x and keeps
// bursty feed renders under the provider's per-client throttle. retryCount and
// retryDelay smooth over the occasional transient 429.
export const RPC_BATCH_SIZE = envInt("NEXT_PUBLIC_RPC_BATCH_SIZE", 10);

const SOMNIA_HTTP_OPTS = {
  batch: { batchSize: RPC_BATCH_SIZE, wait: 16 },
  // Keep per-request budgets tight: callers (readClaimRaw, agent poll loops)
  // have their own outer retries, and a hanging RPC must fail fast enough for
  // serverless routes to fall back to cached data instead of 504ing.
  retryCount: 2,
  retryDelay: 300,
  timeout: 10_000,
};

export function createSomniaPublicClient(): PublicClient {
  return createPublicClient({
    chain: somniaShannon,
    transport: http(getSomniaRpcUrl(), SOMNIA_HTTP_OPTS),
  }) as PublicClient;
}

export function createSomniaHttpTransport() {
  return http(getSomniaRpcUrl(), SOMNIA_HTTP_OPTS);
}

export function createSomniaWalletClient(provider: unknown): WalletClient {
  return createWalletClient({
    chain: somniaShannon,
    transport: custom(provider as any),
  });
}

export function createSomniaWalletClientWithKey(privateKey: string): WalletClient {
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  return createWalletClient({
    chain: somniaShannon,
    account,
    transport: http(getSomniaRpcUrl(), SOMNIA_HTTP_OPTS),
  });
}

// ── Wallet chain-switch helper ────────────────────────────────────────────────
export async function ensureSomniaShannon(ethereum: {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}): Promise<void> {
  const chainIdHex = `0x${somniaShannon.id.toString(16)}`;
  const currentChainId = (await ethereum.request({ method: "eth_chainId" })) as string;

  if (currentChainId === chainIdHex) return;

  try {
    await ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex }],
    });
  } catch (err: any) {
    if (err?.code !== 4902) throw err;
    await ethereum.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: chainIdHex,
          chainName: somniaShannon.name,
          rpcUrls: [getSomniaRpcUrl()],
          nativeCurrency: somniaShannon.nativeCurrency,
          blockExplorerUrls: [SOMNIA_EXPLORER_URL],
        },
      ],
    });
  }
}

// ── Gas unit helpers (native ETH, 18 decimals) ────────────────────────────────
export function weiToStt(wei: bigint | number): number {
  return Number(formatEther(BigInt(wei)));
}

/** @deprecated Use weiToStt; kept for worker compatibility during the transition. */
export const weiToEth = weiToStt;

export function formatSttAmount(wei: bigint | number, decimals = 4): string {
  return `${weiToStt(wei).toFixed(decimals)} STT`;
}
