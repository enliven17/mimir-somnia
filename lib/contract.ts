/**
 * Mimir contract client (Somnia Shannon testnet / viem)
 *
 * Market stakes are USDC (ERC-20, 6 decimals). Gas is native STT.
 * create/challenge require the caller to approve the Mimir contract first.
 */
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  maxUint256,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  somniaShannon,
  getSomniaRpcUrl,
  getContractAddress,
  getExplorerTxUrl,
  ensureSomniaShannon,
  RPC_BATCH_SIZE,
} from "./chain";
import {
  ERC20_ABI,
  USDC_ADDRESS,
  usdcToUnits,
  unitsToUsdc,
  MIN_STAKE_USDC,
} from "./usdc";
import { MIMIR_ABI, STATE, WINNER_SIDE, BPS_DIVISOR } from "./mimir-abi";
import { normalizeCategoryId, ZERO_ADDRESS } from "./constants";
import { decodeClaimTuple } from "./claim-codec";
import { guardChallenge, toCanonicalMode } from "./market-modes";
import { checkWriteAllowed } from "./ops/flags";
import { availableCreatorLiquidityUnits } from "./payout";
import type { VSCacheFreshness } from "./vs-freshness";

// ── Constants ─────────────────────────────────────────────────────────────────
// MIN_STAKE in display USDC (matches Mimir.sol: 2 * 10^6 = 2 USDC)
export { MIN_STAKE_USDC as MIN_STAKE };

export const CONTRACT_ADDRESS = getContractAddress();

// ── Interfaces ────────────────────────────────────────────────────────────────
export interface ClaimChallenger {
  address: string;
  stake: number;
  potential_payout: number;
}

export interface ClaimData {
  id: number;
  creator: string;
  question: string;
  creator_position: string;
  counter_position: string;
  resolution_url: string;
  creator_stake: number;
  total_challenger_stake: number;
  reserved_creator_liability: number;
  available_creator_liability: number;
  deadline: number;
  state: "open" | "active" | "resolved" | "cancelled";
  winner_side: "creator" | "challengers" | "draw" | "unresolvable" | "";
  resolution_summary: string;
  confidence: number;
  category: string;
  parent_id: number;
  challenger_count: number;
  market_type: string;
  odds_mode: string;
  challenger_payout_bps: number;
  handicap_line: string;
  settlement_rule: string;
  max_challengers: number;
  created_at?: number;
  visibility?: "public" | "private";
  is_private?: boolean;
  challengers?: ClaimChallenger[];
  first_challenger?: string;
  challenger_addresses?: string[];
  total_pot: number;
  evidence_hash?: string;          // keccak256 of oracle evidence — on-chain reasoning trace
  /** @deprecated not used — the oracle resolves automatically */
  resolve_attempts?: number;
  /** @deprecated not used — the oracle resolves automatically */
  creator_requested_resolve?: boolean;
  /** @deprecated not used — the oracle resolves automatically */
  challenger_requested_resolve?: boolean;
}

export interface VSData {
  id: number;
  creator: string;
  opponent: string;
  question: string;
  creator_position: string;
  opponent_position: string;
  resolution_url: string;
  stake_amount: number;
  deadline: number;
  state: "open" | "accepted" | "resolved" | "cancelled";
  winner: string;
  resolution_summary: string;
  created_at?: number;
  category: string;
  challengers?: ClaimChallenger[];
  counter_position?: string;
  creator_stake?: number;
  total_challenger_stake?: number;
  reserved_creator_liability?: number;
  available_creator_liability?: number;
  winner_side?: ClaimData["winner_side"];
  confidence?: number;
  parent_id?: number;
  challenger_count?: number;
  market_type?: string;
  odds_mode?: string;
  challenger_payout_bps?: number;
  handicap_line?: string;
  settlement_rule?: string;
  max_challengers?: number;
  visibility?: ClaimData["visibility"];
  is_private?: boolean;
  total_pot?: number;
  challenger_addresses?: string[];
  // Resolution-request flow (optional, surfaces off-chain UI state)
  creator_requested_resolve?: boolean;
  challenger_requested_resolve?: boolean;
  resolve_attempts?: number;
}

export interface CreateClaimParams {
  question: string;
  creator_position: string;
  counter_position: string;
  resolution_url: string;
  deadline: number;
  stake_amount: number;         // whole USDC (e.g. 5 = 5 USDC)
  category?: string;
  parent_id?: number;
  market_type?: string;
  odds_mode?: string;
  challenger_payout_bps?: number;
  handicap_line?: string;
  settlement_rule?: string;
  max_challengers?: number;
  visibility?: "public" | "private";
  invite_key?: string;
}

export interface ContractWriteResult {
  txHash: string;
  explorerUrl?: string;
  /** @deprecated use explorerUrl */
  explorerTxHash?: string;
  receipt: unknown;
  pending?: boolean;
}

export interface ClaimWriteResult extends ContractWriteResult {
  claimId: number | null;
}

export interface VSFeedSnapshot {
  items: VSData[];
  cache: VSCacheFreshness | null;
}

export interface VSDetailSnapshot {
  item: VSData | null;
  cache: VSCacheFreshness | null;
}

// ── State / side mappers ──────────────────────────────────────────────────────
function mapState(n: number): ClaimData["state"] {
  switch (n) {
    case STATE.OPEN:      return "open";
    case STATE.ACTIVE:    return "active";
    case STATE.RESOLVED:  return "resolved";
    case STATE.CANCELLED: return "cancelled";
    default: return "open";
  }
}

function mapWinnerSide(n: number): ClaimData["winner_side"] {
  switch (n) {
    case WINNER_SIDE.CREATOR:      return "creator";
    case WINNER_SIDE.CHALLENGERS:  return "challengers";
    case WINNER_SIDE.DRAW:         return "draw";
    case WINNER_SIDE.UNRESOLVABLE: return "unresolvable";
    default: return "";
  }
}

// ── viem public client (singleton per process) ────────────────────────────────
// Uses the same JSON-RPC batching transport as createSomniaPublicClient — see
// lib/chain.ts SOMNIA_HTTP_OPTS for the rationale.
let _publicClient: PublicClient | null = null;
function getPublicClient(): PublicClient {
  if (!_publicClient) {
    _publicClient = createPublicClient({
      chain: somniaShannon,
      transport: http(getSomniaRpcUrl(), {
        batch: { batchSize: RPC_BATCH_SIZE, wait: 16 },
        retryCount: 3,
        retryDelay: 300,
        timeout: 20_000,
      }),
    }) as PublicClient;
  }
  return _publicClient;
}

// ── Bulk-read concurrency limiter ─────────────────────────────────────────────
// Public testnet RPCs can return 429 when hit with hundreds of parallel
// readContract calls. Every claim costs 3 RPC calls (getClaim +
// getClaimMarketConfig + getChallengerList), so `Promise.all` over 100+ claims
// = ~300 parallel requests = throttled.
//
// We funnel all bulk claim reads through this helper instead. Default of 5
// keeps peak concurrency at ~15 (5 claims × 3 calls), well within any sane
// RPC rate limit. Tuneable via NEXT_PUBLIC_RPC_READ_CONCURRENCY.
const READ_CONCURRENCY = (() => {
  const raw = Number(
    (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_RPC_READ_CONCURRENCY) || "5"
  );
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5;
})();

async function mapWithConcurrency<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency = READ_CONCURRENCY,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function readClaimsRange(startId: number, count: number): Promise<(ClaimData | null)[]> {
  const ids = Array.from({ length: count }, (_, i) => startId + i);
  return mapWithConcurrency(ids, (id) => readClaimRaw(id));
}

// ── Raw on-chain read ─────────────────────────────────────────────────────────
const READ_CLAIM_RETRY_ATTEMPTS = 3;
const READ_CLAIM_RETRY_BASE_MS = 200;

async function readClaimContractTriplet(client: PublicClient, claimId: number) {
  return Promise.all([
    client.readContract({
      address:      CONTRACT_ADDRESS,
      abi:          MIMIR_ABI,
      functionName: "getClaim",
      args:         [BigInt(claimId)],
    }) as Promise<readonly any[]>,
    client.readContract({
      address:      CONTRACT_ADDRESS,
      abi:          MIMIR_ABI,
      functionName: "getClaimMarketConfig",
      args:         [BigInt(claimId)],
    }) as Promise<readonly any[]>,
    client.readContract({
      address:      CONTRACT_ADDRESS,
      abi:          MIMIR_ABI,
      functionName: "getChallengerList",
      args:         [BigInt(claimId)],
    }) as Promise<[string[], bigint[]]>,
  ]);
}

export async function readClaimRaw(claimId: number): Promise<ClaimData | null> {
  const client = getPublicClient();
  let base: readonly any[] | null = null;
  let market: readonly any[] | null = null;
  let challengerData: [string[], bigint[]] | null = null;

  let lastError: unknown = null;
  for (let attempt = 0; attempt < READ_CLAIM_RETRY_ATTEMPTS; attempt += 1) {
    try {
      [base, market, challengerData] = await readClaimContractTriplet(client, claimId);
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      if (attempt < READ_CLAIM_RETRY_ATTEMPTS - 1) {
        const backoff = READ_CLAIM_RETRY_BASE_MS * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }

  if (lastError || !base || !market || !challengerData) {
    if (lastError) {
      console.warn(`[readClaimRaw] claim ${claimId} failed after ${READ_CLAIM_RETRY_ATTEMPTS} attempts`, lastError);
    }
    return null;
  }

  try {
    const decoded = decodeClaimTuple(claimId, base, market);
    if (!decoded) return null;

    const creatorStakeUsdc = unitsToUsdc(decoded.creatorStake);
    const totalChStakeUsdc = unitsToUsdc(decoded.totalChallengerStake);
    const reservedUsdc     = unitsToUsdc(decoded.reservedCreatorLiability);

    const [chAddrs, chStakes] = challengerData;
    const payBps  = Number(decoded.challengerPayoutBps);
    const isFixed = decoded.oddsMode === "fixed";
    const challengers: ClaimChallenger[] = chAddrs.map((addr, i) => {
      const stake  = unitsToUsdc(chStakes[i]);
      const payout = isFixed
        ? (stake * payBps) / BPS_DIVISOR
        : stake + (totalChStakeUsdc > 0 ? (stake / totalChStakeUsdc) * creatorStakeUsdc : 0);
      return { address: addr, stake, potential_payout: payout };
    });

    const availLiab = Math.max(0, creatorStakeUsdc - reservedUsdc);

    return {
      id:                         claimId,
      creator:                    decoded.creator,
      question:                   decoded.question,
      creator_position:           decoded.creatorPosition,
      counter_position:           decoded.counterPosition,
      resolution_url:             decoded.resolutionUrl,
      creator_stake:              creatorStakeUsdc,
      total_challenger_stake:     totalChStakeUsdc,
      reserved_creator_liability: reservedUsdc,
      available_creator_liability: availLiab,
      deadline:                   Number(decoded.deadline),
      state:                      mapState(decoded.state),
      winner_side:                mapWinnerSide(decoded.winnerSide),
      resolution_summary:         decoded.resolutionSummary,
      confidence:                 decoded.confidence,
      category:                   normalizeCategoryId(decoded.category),
      parent_id:                  Number(decoded.parentId),
      challenger_count:           Number(decoded.challengerCount),
      created_at:                 Number(decoded.createdAt),
      evidence_hash:              decoded.evidenceHash,
      market_type:                decoded.marketType,
      odds_mode:                  decoded.oddsMode,
      challenger_payout_bps:      payBps,
      handicap_line:              decoded.handicapLine,
      settlement_rule:            decoded.settlementRule,
      max_challengers:            Number(decoded.maxChallengers),
      visibility:                 decoded.isPrivate ? "private" : "public",
      is_private:                 decoded.isPrivate,
      challengers,
      first_challenger:           chAddrs[0] ?? ZERO_ADDRESS,
      challenger_addresses:       chAddrs,
      total_pot:                  creatorStakeUsdc + totalChStakeUsdc,
    };
  } catch (err) {
    console.warn(`[readClaimRaw] decode failed for claim ${claimId}`, err);
    return null;
  }
}

// ── Public read functions ─────────────────────────────────────────────────────
export async function getClaim(claimId: number): Promise<ClaimData | null> {
  return readClaimRaw(claimId);
}

export async function getClaimCount(): Promise<number> {
  const client = getPublicClient();
  const count = await client.readContract({
    address:      CONTRACT_ADDRESS,
    abi:          MIMIR_ABI,
    functionName: "claimCount",
  }) as bigint;
  return Number(count);
}

export async function getVSSummaries(startId: number, limit: number): Promise<VSData[]> {
  const results = await readClaimsRange(startId, limit);
  return (results.filter(Boolean) as ClaimData[]).map(mapClaimToVS);
}

export async function getUserVSSummaries(address: string): Promise<VSData[]> {
  const count = await getClaimCount();
  if (count <= 0) return [];

  const all = await readClaimsRange(1, count);

  const addr = address.toLowerCase();
  return all
    .filter((c): c is ClaimData => {
      if (!c) return false;
      const isCreator    = c.creator.toLowerCase() === addr;
      const isChallenger = (c.challenger_addresses ?? []).some(
        (a) => a.toLowerCase() === addr
      );
      return isCreator || isChallenger;
    })
    .map(mapClaimToVS);
}

export async function getUserStats(address: string): Promise<{ wins: number; losses: number }> {
  const client = getPublicClient();
  const [wins, losses] = (await client.readContract({
    address:      CONTRACT_ADDRESS,
    abi:          MIMIR_ABI,
    functionName: "getUserStats",
    args:         [address as `0x${string}`],
  })) as [bigint, bigint];
  return { wins: Number(wins), losses: Number(losses) };
}

export async function getPlatformStats(): Promise<{
  total_claims: number;
  total_resolved: number;
  total_pool: number;
}> {
  const client = getPublicClient();
  const [totalClaims, resolved, balance] = (await client.readContract({
    address:      CONTRACT_ADDRESS,
    abi:          MIMIR_ABI,
    functionName: "getPlatformStats",
  })) as readonly [bigint, bigint, bigint, bigint, bigint];
  return {
    total_claims:   Number(totalClaims),
    total_resolved: Number(resolved),
    total_pool:     unitsToUsdc(balance),
  };
}

// ── Fast feed (browser uses /api/vs, server reads directly) ──────────────────
export async function getAllVSFast(): Promise<VSFeedSnapshot> {
  if (typeof window !== "undefined") {
    const res = await fetch("/api/vs");
    if (!res.ok) throw new Error(`/api/vs returned ${res.status}`);
    const data = await res.json();
    return { items: data.items ?? [], cache: data.cache ?? null };
  }
  return getAllVSDirect();
}

export async function getAllVSDirect(): Promise<VSFeedSnapshot> {
  const count = await getClaimCount();
  if (count <= 0) return { items: [], cache: makeLiveFreshness() };

  // Single concurrency-limited read across all IDs — paginating then
  // Promise.all-ing pages just multiplied the concurrent request burst by
  // page-count and was the main 429 source on the public RPC.
  const all = await readClaimsRange(1, count);
  return {
    items: (all.filter(Boolean) as ClaimData[])
      .map(mapClaimToVS)
      .sort((a, b) => b.id - a.id),
    cache: makeLiveFreshness(),
  };
}

export async function getUserVSFast(address: string): Promise<VSFeedSnapshot> {
  if (typeof window !== "undefined") {
    const res = await fetch(`/api/vs/user/${address}`);
    if (!res.ok) throw new Error(`/api/vs/user returned ${res.status}`);
    const data = await res.json();
    return { items: data.items ?? [], cache: data.cache ?? null };
  }
  const items = await getUserVSSummaries(address);
  return { items: items.sort((a, b) => b.id - a.id), cache: makeLiveFreshness() };
}

/** Returns VSData | null directly (backwards compatible). */
export async function getVS(
  vsId: number,
  opts?: { inviteKey?: string; viewerAddress?: string }
): Promise<VSData | null> {
  if (typeof window !== "undefined") {
    const url = opts?.inviteKey
      ? `/api/vs/${vsId}?invite=${encodeURIComponent(opts.inviteKey)}`
      : `/api/vs/${vsId}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return data.item ?? null;
  }
  const claim = await readClaimRaw(vsId);
  return claim ? mapClaimToVS(claim) : null;
}

/** Returns VSDetailSnapshot with cache metadata. */
export async function getVSFull(
  vsId: number,
  opts?: { inviteKey?: string; viewerAddress?: string }
): Promise<VSDetailSnapshot> {
  if (typeof window !== "undefined") {
    const url = opts?.inviteKey
      ? `/api/vs/${vsId}?invite=${encodeURIComponent(opts.inviteKey)}`
      : `/api/vs/${vsId}`;
    const res = await fetch(url);
    if (!res.ok) return { item: null, cache: null };
    const data = await res.json();
    return { item: data.item ?? null, cache: data.cache ?? null };
  }
  const claim = await readClaimRaw(vsId);
  return { item: claim ? mapClaimToVS(claim) : null, cache: makeLiveFreshness() };
}

// ── USDC allowance ────────────────────────────────────────────────────────────
/** Approve the Mimir contract for USDC. Callers check the allowance first. */
async function approveUsdc(
  walletClient: WalletClient,
  owner: `0x${string}`,
): Promise<void> {
  const hash = await walletClient.writeContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [CONTRACT_ADDRESS, maxUint256],
    account: owner,
    chain: somniaShannon,
  });
  const receipt = await getPublicClient().waitForTransactionReceipt({ hash });
  if (receipt.status === "reverted") throw new Error("USDC approve reverted");
}

/** True when the allowance already covers this stake. */
async function hasUsdcAllowance(owner: `0x${string}`, amountUnits: bigint): Promise<boolean> {
  if (amountUnits <= 0n) return true;
  const current = (await getPublicClient().readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [owner, CONTRACT_ADDRESS],
  })) as bigint;
  return current >= amountUnits;
}

/**
 * EIP-5792 wallets can run approve + create/challenge as
 * one atomic batch, so the user signs once instead of twice. Returns null when
 * the wallet cannot batch atomically, and the caller falls back to two txs.
 */
async function trySendAtomicBatch(
  wc: WalletClient,
  account: `0x${string}`,
  functionName: string,
  args: unknown[],
): Promise<ContractWriteResult | null> {
  try {
    const capabilities = await wc.getCapabilities({ account, chainId: somniaShannon.id });
    // "supported" means atomic — "ready"/undefined wallets would split the batch
    // into separate confirmations, which is exactly what we are avoiding.
    if (capabilities?.atomic?.status !== "supported") return null;
  } catch {
    return null; // wallet_getCapabilities unsupported → classic EOA
  }

  const { id } = await wc.sendCalls({
    account,
    chain: somniaShannon,
    calls: [
      {
        to: USDC_ADDRESS,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [CONTRACT_ADDRESS, maxUint256],
      },
      {
        to: CONTRACT_ADDRESS,
        abi: MIMIR_ABI,
        functionName: functionName as never,
        args: args as never,
      },
    ],
  });

  const status = await wc.waitForCallsStatus({ id, timeout: 60_000 });
  if (status.status !== "success") {
    throw new Error(`Batched approve + ${functionName} failed (${status.status})`);
  }
  // Atomic batch = one transaction on chain; the contract call is the last receipt.
  const receipt = status.receipts?.[status.receipts.length - 1];
  const txHash = receipt?.transactionHash;
  if (!txHash) throw new Error("Batched call returned no transaction hash");

  const explorerUrl = getExplorerTxUrl(txHash);
  return { txHash, explorerUrl, explorerTxHash: explorerUrl, receipt, pending: false };
}

// ── Write: browser (wagmi / injected wallet) ──────────────────────────────────
async function sendBrowserTx(
  functionName: string,
  args: unknown[],
  stakeUsdc: number
): Promise<ContractWriteResult> {
  const ethereum =
    typeof window !== "undefined" ? (window as any).ethereum : undefined;
  if (!ethereum) throw new Error("No wallet connected. Please connect a wallet first.");

  await ensureSomniaShannon(ethereum);

  const accounts: string[] = await ethereum.request({ method: "eth_accounts" });
  if (!accounts.length) throw new Error("Wallet not connected");
  const account = accounts[0] as `0x${string}`;

  const wc = createWalletClient({
    chain:     somniaShannon,
    transport: custom(ethereum),
    account,
  });

  const stakeUnits = stakeUsdc > 0 ? usdcToUnits(stakeUsdc) : 0n;
  const needsApprove = stakeUnits > 0n && !(await hasUsdcAllowance(account, stakeUnits));

  if (needsApprove) {
    // One-confirmation path when the wallet can batch atomically.
    const batched = await trySendAtomicBatch(wc, account, functionName, args);
    if (batched) return batched;
    // Classic EOA: approve, then write.
    await approveUsdc(wc, account);
  }

  // Simulate against the latest chain state immediately before asking for the
  // signature. This catches a rival filling the last slot or consuming fixed-
  // odds liquidity between render and submit, and turns the RPC revert into a
  // useful message without spending gas.
  try {
    await getPublicClient().simulateContract({
      address: CONTRACT_ADDRESS,
      abi: MIMIR_ABI,
      functionName: functionName as any,
      args: args as any,
      account,
    });
  } catch (error) {
    const candidate = error as { shortMessage?: string; details?: string; message?: string };
    const reason = candidate.shortMessage || candidate.details || candidate.message || "simulation failed";
    throw new Error(`Transaction can no longer be completed: ${reason}`);
  }

  const txHash = await wc.writeContract({
    address:      CONTRACT_ADDRESS,
    abi:          MIMIR_ABI,
    functionName: functionName as any,
    args:         args as any,
    account,
    chain:        somniaShannon,
  });

  // Base blocks are ~2s — the receipt normally arrives well inside the timeout
  try {
    const receipt = await Promise.race([
      getPublicClient().waitForTransactionReceipt({ hash: txHash }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 30_000)),
    ]);
    if ((receipt as any).status === "reverted") throw new Error("Transaction reverted");
    const explorerUrl = getExplorerTxUrl(txHash);
    return { txHash, explorerUrl, explorerTxHash: explorerUrl, receipt, pending: false };
  } catch (err: any) {
    if (err?.message === "Transaction reverted") throw err;
    const explorerUrl = getExplorerTxUrl(txHash);
    return { txHash, explorerUrl, explorerTxHash: explorerUrl, receipt: null, pending: true };
  }
}

// ── Write: server (private key) ───────────────────────────────────────────────
async function sendServerTx(
  privateKey: string,
  functionName: string,
  args: unknown[],
  stakeUsdc: number
): Promise<ContractWriteResult> {
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const walletClient = createWalletClient({
    chain:     somniaShannon,
    transport: http(getSomniaRpcUrl()),
    account,
  });

  if (stakeUsdc > 0 && !(await hasUsdcAllowance(account.address, usdcToUnits(stakeUsdc)))) {
    await approveUsdc(walletClient, account.address);
  }

  const txHash = await walletClient.writeContract({
    address:      CONTRACT_ADDRESS,
    abi:          MIMIR_ABI,
    functionName: functionName as any,
    args:         args as any,
    account,
    chain:        somniaShannon,
  });

  const receipt = await getPublicClient().waitForTransactionReceipt({ hash: txHash });
  if (receipt.status === "reverted") throw new Error("Transaction reverted");
  return { txHash, explorerUrl: getExplorerTxUrl(txHash), receipt };
}

// ── Write: demo relay (via server API) ───────────────────────────────────────
async function sendDemoTx(
  action: string,
  params: Record<string, unknown>
): Promise<ContractWriteResult & { claimId: number | null }> {
  const res = await fetch("/api/demo/write", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ action, params }),
  });
  if (!res.ok) throw new Error(`Demo relay error: ${res.status}`);
  const data = await res.json();
  return {
    txHash:    data.txHash ?? "",
    explorerUrl: data.txHash ? getExplorerTxUrl(data.txHash) : undefined,
    receipt:   null,
    pending:   data.pending ?? false,
    claimId:   data.claimId ?? null,
  };
}

// ── Public write functions ────────────────────────────────────────────────────
export async function createClaim(
  wallet: string,
  params: CreateClaimParams
): Promise<ClaimWriteResult> {
  // Incident kill switch. Create and stake pause independently, so a pricing bug
  // can stop new markets without freezing settlement or withdrawals.
  const gate = checkWriteAllowed({ capability: "create_market" });
  if (!gate.allowed) throw new Error(gate.detail ?? "market creation is unavailable");

  const args = buildCreateArgs(params);

  if (isDemoMode()) {
    return sendDemoTx("create_claim", params as unknown as Record<string, unknown>);
  }

  const result = await sendBrowserTx("createClaim", args, params.stake_amount);
  const count  = await getClaimCount().catch(() => null);
  return { ...result, claimId: count };
}

/**
 * Mode-aware pre-flight for a challenge, run against FRESH chain state.
 *
 * The v1 contract enforces the challenger slot count but accepts any stake above
 * MIN_STAKE, so a duel's equal-stake rule has no on-chain enforcement yet. This
 * guard is therefore run here — on every write path — rather than in the create
 * form. It re-reads the claim instead of trusting UI state, because the pool and
 * the free slots can change between render and submit.
 *
 * Throws with the guard's message so the caller surfaces a real reason instead of
 * an opaque revert.
 */
export async function assertChallengeAllowed(
  claimId: number,
  stakeAmount: number,
): Promise<void> {
  const claim = await readClaimRaw(claimId);
  if (!claim) throw new Error(`Claim ${claimId} not found`);

  const mode = toCanonicalMode({
    marketType: claim.market_type,
    oddsMode: claim.odds_mode,
    maxChallengers: claim.max_challengers,
  });

  const result = guardChallenge({
    settlementMode: mode.settlementMode,
    creatorStake: claim.creator_stake,
    challengerStake: stakeAmount,
    existingChallengers: claim.challenger_count,
    maxChallengers: claim.max_challengers,
    challengerPayoutBps: claim.challenger_payout_bps,
    availableCreatorLiquidity: unitsToUsdc(
      availableCreatorLiquidityUnits({
        creatorStakeUnits: usdcToUnits(claim.creator_stake),
        reservedLiabilityUnits: usdcToUnits(claim.reserved_creator_liability),
      }),
    ),
  });

  if (!result.ok) throw new Error(result.message ?? "challenge not allowed");
}

export async function challengeClaim(
  wallet: string,
  claimId: number,
  stakeAmount: number,
  inviteKey = ""
): Promise<ClaimWriteResult> {
  if (isDemoMode()) {
    return sendDemoTx("challenge_claim", { claimId, stakeAmount, inviteKey });
  }
  const stakeGate = checkWriteAllowed({ capability: "stake" });
  if (!stakeGate.allowed) throw new Error(stakeGate.detail ?? "staking is unavailable");
  await assertChallengeAllowed(claimId, stakeAmount);
  const result = await sendBrowserTx(
    "challengeClaim",
    [BigInt(claimId), usdcToUnits(stakeAmount), inviteKey],
    stakeAmount
  );
  return { ...result, claimId };
}

export async function resolveClaim(
  wallet: string,
  claimId: number
): Promise<ClaimWriteResult> {
  if (isDemoMode()) {
    return sendDemoTx("resolve_claim", { claimId });
  }
  // Browser resolution is not supported — resolution is oracle-only.
  // This path allows demo/test only.
  throw new Error(
    "Claims are resolved by the Mimir oracle agent. Connect as oracle to resolve manually."
  );
}

export async function cancelClaim(
  wallet: string,
  claimId: number
): Promise<ClaimWriteResult> {
  if (isDemoMode()) {
    return sendDemoTx("cancel_claim", { claimId });
  }
  const result = await sendBrowserTx("cancelClaim", [BigInt(claimId)], 0);
  return { ...result, claimId };
}

export async function createRematch(
  wallet: string,
  parentId: number,
  params: Pick<CreateClaimParams, "deadline" | "stake_amount" | "invite_key">
): Promise<ClaimWriteResult> {
  if (isDemoMode()) {
    return sendDemoTx("create_rematch", { parentId, ...params });
  }
  const result = await sendBrowserTx(
    "createRematch",
    [BigInt(parentId), BigInt(params.deadline), usdcToUnits(params.stake_amount), params.invite_key ?? ""],
    params.stake_amount
  );
  const count = await getClaimCount().catch(() => null);
  return { ...result, claimId: count };
}

// ── Server-side demo write ────────────────────────────────────────────────────
export async function executeDemoWrite(
  action: string,
  params: Record<string, unknown>
): Promise<ClaimWriteResult> {
  const privateKey = getDemoPrivateKey(action);
  if (!privateKey) throw new Error(`No demo key configured for action: ${action}`);

  if (action === "create_claim") {
    const p = params as unknown as CreateClaimParams;
    const args = buildCreateArgs(p);
    const result = await sendServerTx(privateKey, "createClaim", args, p.stake_amount);
    const count  = await getClaimCount().catch(() => null);
    return { ...result, claimId: count };
  }

  if (action === "challenge_claim") {
    const { claimId, stakeAmount, inviteKey = "" } = params as any;
    // Same guard on the server signer path — a relay must not be able to bypass
    // the mode rules a browser caller is held to.
    await assertChallengeAllowed(Number(claimId), Number(stakeAmount));
    const result = await sendServerTx(
      privateKey, "challengeClaim",
      [BigInt(claimId), usdcToUnits(stakeAmount), inviteKey],
      stakeAmount
    );
    return { ...result, claimId: Number(claimId) };
  }

  if (action === "resolve_claim") {
    // Demo resolve: oracle agent handles real resolution; demo just simulates
    const { claimId } = params as any;
    throw new Error(`Claim ${claimId}: use the oracle agent to resolve.`);
  }

  if (action === "cancel_claim") {
    const { claimId } = params as any;
    const result = await sendServerTx(privateKey, "cancelClaim", [BigInt(claimId)], 0);
    return { ...result, claimId: Number(claimId) };
  }

  if (action === "create_rematch") {
    const { parentId, deadline, stake_amount, invite_key = "" } = params as any;
    const result = await sendServerTx(
      privateKey, "createRematch",
      [BigInt(parentId), BigInt(deadline), usdcToUnits(stake_amount), invite_key],
      stake_amount
    );
    const count = await getClaimCount().catch(() => null);
    return { ...result, claimId: count };
  }

  throw new Error(`Unknown demo action: ${action}`);
}

// ── Helper: build createClaim args tuple ──────────────────────────────────────
function buildCreateArgs(p: CreateClaimParams): unknown[] {
  return [[
    p.question,
    p.creator_position,
    p.counter_position,
    p.resolution_url,
    BigInt(p.deadline),
    usdcToUnits(p.stake_amount),
    p.category ?? "custom",
    BigInt(p.parent_id ?? 0),
    p.market_type ?? "binary",
    p.odds_mode ?? "pool",
    BigInt(p.challenger_payout_bps ?? 0),
    p.handicap_line ?? "",
    p.settlement_rule ?? "",
    BigInt(p.max_challengers ?? 0),
    p.visibility === "private",
    p.invite_key ?? "",
    `0x${"00".repeat(32)}`,
    ZERO_ADDRESS,
  ]];
}

// ── Demo mode helpers ─────────────────────────────────────────────────────────
function isDemoMode(): boolean {
  return process.env.NEXT_PUBLIC_DEMO_MODE === "1";
}

function getDemoPrivateKey(action: string): string | undefined {
  if (action === "create_claim" || action === "create_rematch") {
    return process.env.DEMO_CREATOR_PRIVATE_KEY || process.env.DEMO_SIGNER_PRIVATE_KEY;
  }
  if (action === "challenge_claim") {
    return process.env.DEMO_CHALLENGER_PRIVATE_KEY || process.env.DEMO_SIGNER_PRIVATE_KEY;
  }
  return process.env.DEMO_SIGNER_PRIVATE_KEY;
}

// ── Freshness helper ──────────────────────────────────────────────────────────
function makeLiveFreshness(): VSCacheFreshness {
  return {
    source:           "contract",
    status:           "live",
    lastUpdatedAt:    new Date().toISOString(),
    ageMs:            0,
    freshnessWindowMs: 1,
  };
}

// ── VS data helpers ───────────────────────────────────────────────────────────
function isSameAddress(a?: string, b?: string) {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

export function mapClaimToVS(claim: ClaimData): VSData {
  const firstChallenger = claim.first_challenger ?? ZERO_ADDRESS;
  const state = claim.state === "active" ? "accepted" : (claim.state as VSData["state"]);

  let winner = ZERO_ADDRESS;
  if (claim.winner_side === "creator") winner = claim.creator;
  else if (claim.winner_side === "challengers") {
    winner = claim.challenger_addresses?.[0] ?? firstChallenger;
  }

  return {
    ...claim,
    opponent:          firstChallenger,
    opponent_position: claim.counter_position,
    stake_amount:      claim.creator_stake,
    state,
    winner,
  };
}

export function isVSPrivate(vs: Pick<VSData, "is_private" | "visibility">) {
  return Boolean(vs.is_private || vs.visibility === "private");
}

export function getVSConfiguredMaxChallengers(vs: VSData) {
  return typeof vs.max_challengers === "number" && vs.max_challengers > 0
    ? vs.max_challengers
    : 1;
}

export function getVSChallengerCount(vs: VSData) {
  if (typeof vs.challenger_count === "number" && vs.challenger_count >= 0) {
    return vs.challenger_count;
  }
  return vs.opponent !== ZERO_ADDRESS ? 1 : 0;
}

export function hasZeroAddressWinner(vs: VSData) {
  return !vs.winner || vs.winner === ZERO_ADDRESS;
}

export function isVSMultiChallengerWin(vs: VSData) {
  return vs.winner_side === "challengers" && getVSChallengerCount(vs) !== 1;
}

export function getVSTotalPot(vs: VSData) {
  if (typeof vs.total_pot === "number" && Number.isFinite(vs.total_pot)) return vs.total_pot;
  if (typeof vs.creator_stake === "number" && typeof vs.total_challenger_stake === "number") {
    return vs.creator_stake + vs.total_challenger_stake;
  }
  return vs.stake_amount * (vs.opponent === ZERO_ADDRESS ? 1 : 2);
}

export function getVSSingleWinnerPayout(vs: VSData): number | null {
  if (!hasVSWinner(vs)) return 0;

  if (vs.winner_side === "creator" || isSameAddress(vs.winner, vs.creator)) {
    return getVSTotalPot(vs);
  }

  if (vs.winner_side === "challengers") {
    if (getVSChallengerCount(vs) !== 1) return null;
    const stake = vs.total_challenger_stake ?? vs.stake_amount;
    if (vs.odds_mode === "fixed" && (vs.challenger_payout_bps ?? 0) > 0) {
      return Math.floor((stake * vs.challenger_payout_bps!) / BPS_DIVISOR);
    }
    return getVSTotalPot(vs);
  }

  return getVSTotalPot(vs);
}

export function hasVSWinner(vs: VSData) {
  return (
    vs.winner_side === "creator" ||
    vs.winner_side === "challengers" ||
    vs.winner !== ZERO_ADDRESS
  );
}

// Mirrors CHALLENGE_LOCK_SECONDS from Mimir.sol — challenges must arrive at least
// this long before the deadline, otherwise the on-chain tx reverts with
// "Mimir: challenge window closed".
export const VS_CHALLENGE_LOCK_SECONDS = 60;

export function isVSJoinable(vs: VSData, address?: string | null) {
  if (vs.state !== "open" && vs.state !== "accepted") return false;
  if (address) {
    if (isSameAddress(vs.creator, address) || didUserChallengeVS(vs, address)) return false;
  }
  if (getVSChallengerCount(vs) >= getVSConfiguredMaxChallengers(vs)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (vs.deadline > 0 && nowSec + VS_CHALLENGE_LOCK_SECONDS > vs.deadline) return false;
  return true;
}

export function didUserChallengeVS(vs: VSData, address?: string | null) {
  if (!address) return false;
  if ((vs.challenger_addresses ?? []).some((a) => isSameAddress(a, address))) return true;
  return vs.opponent !== ZERO_ADDRESS && isSameAddress(vs.opponent, address);
}

export function didUserWinVS(vs: VSData, address?: string | null) {
  if (!address || !hasVSWinner(vs)) return false;
  if (vs.winner_side === "creator") return isSameAddress(vs.creator, address);
  if (vs.winner_side === "challengers") return didUserChallengeVS(vs, address);
  return isSameAddress(vs.winner, address);
}

export function didUserLoseVS(vs: VSData, address?: string | null) {
  if (!address || !hasVSWinner(vs)) return false;
  const involved = isSameAddress(vs.creator, address) || didUserChallengeVS(vs, address);
  return involved && !didUserWinVS(vs, address);
}

function getVSUserChallenger(vs: VSData, address?: string | null) {
  if (!address) return null;
  return (vs.challengers ?? []).find((challenger) =>
    isSameAddress(challenger.address, address)
  ) ?? null;
}

function getVSUserChallengerStake(vs: VSData, address?: string | null): number {
  const challenger = getVSUserChallenger(vs, address);
  if (challenger && Number.isFinite(challenger.stake)) return challenger.stake;
  const n = Math.max(1, getVSChallengerCount(vs));
  if ((vs.total_challenger_stake ?? 0) > 0) {
    return n <= 1 ? vs.total_challenger_stake! : vs.total_challenger_stake! / n;
  }
  return vs.stake_amount ?? 0;
}

export function getVSUserCommittedStake(vs: VSData, address?: string | null): number {
  if (!address) return 0;
  if (isSameAddress(vs.creator, address)) {
    return vs.creator_stake ?? vs.stake_amount ?? 0;
  }
  if (!didUserChallengeVS(vs, address)) return 0;
  return getVSUserChallengerStake(vs, address);
}

export function getVSUserWinAmount(vs: VSData, address?: string | null) {
  if (!didUserWinVS(vs, address)) return 0;
  if (vs.winner_side === "creator") return getVSTotalPot(vs);
  if (vs.winner_side === "challengers") {
    const challenger = getVSUserChallenger(vs, address);
    if (challenger && Number.isFinite(challenger.potential_payout)) {
      return challenger.potential_payout;
    }

    const stake = getVSUserChallengerStake(vs, address);
    if (vs.odds_mode === "fixed" && (vs.challenger_payout_bps ?? 0) > 0) {
      return (stake * vs.challenger_payout_bps!) / BPS_DIVISOR;
    }

    const totalChallengerStake = vs.total_challenger_stake ?? stake;
    const creatorStake = vs.creator_stake ?? vs.stake_amount ?? 0;
    if (totalChallengerStake <= 0) return stake;
    return stake + (stake * creatorStake) / totalChallengerStake;
  }
  return getVSTotalPot(vs);
}

// ── Legacy aliases (backwards compat with VS detail/create pages) ─────────────

/** Alias for challengeClaim — kept for page compatibility */
export async function acceptVS(
  wallet: string,
  claimId: number,
  stakeAmount: number,
  inviteKey = ""
): Promise<ClaimWriteResult> {
  return challengeClaim(wallet, claimId, stakeAmount, inviteKey);
}

// ── Server-layer aliases (used by lib/server/vs-cache.ts + vs-index.ts) ──────

/** Returns open/active public claims as VSData[]. */
export async function getOpenVSSummaries(): Promise<VSData[]> {
  const count = await getClaimCount();
  if (count <= 0) return [];
  const all = await readClaimsRange(1, count);
  return (all.filter(Boolean) as ClaimData[])
    .filter((c) => (c.state === "open" || c.state === "active") && !c.is_private)
    .map(mapClaimToVS);
}

/** Returns paginated claims as ClaimData (for server-side indexer). */
export async function getClaimSummaries(startId: number, limit: number): Promise<ClaimData[]> {
  const results = await readClaimsRange(startId, limit);
  return results.filter(Boolean) as ClaimData[];
}

/** Returns a single claim, optionally checking invite key. */
export async function getClaimWithAccess(
  claimId: number,
  _inviteKey?: string
): Promise<ClaimData | null> {
  return readClaimRaw(claimId);
}

/** Returns open/active public claims as ClaimData. */
export async function getOpenClaimSummaries(): Promise<ClaimData[]> {
  const count = await getClaimCount();
  if (count <= 0) return [];
  const all = await readClaimsRange(1, count);
  return (all.filter(Boolean) as ClaimData[]).filter(
    (c) => (c.state === "open" || c.state === "active") && !c.is_private
  );
}

/** Returns claims for a user as ClaimData. */
export async function getUserClaimSummaries(address: string): Promise<ClaimData[]> {
  const count = await getClaimCount();
  if (count <= 0) return [];
  const all = await readClaimsRange(1, count);
  const addr = address.toLowerCase();
  return (all.filter(Boolean) as ClaimData[]).filter((c) => {
    const isCreator    = c.creator.toLowerCase() === addr;
    const isChallenger = (c.challenger_addresses ?? []).some((a) => a.toLowerCase() === addr);
    return isCreator || isChallenger;
  });
}

/** @deprecated use getAllVSFast */
export async function getAllVSSnapshot(
  opts?: { forceRefresh?: boolean }
): Promise<VSFeedSnapshot> {
  // In the browser this MUST go through /api/vs (the indexed cache): reading
  // every claim directly from the public testnet RPC (~3 calls per claim) trips
  // its per-client rate limit and the whole feed comes back empty.
  if (typeof window !== "undefined") {
    const res = await fetch(opts?.forceRefresh ? "/api/vs?refresh=1" : "/api/vs");
    if (!res.ok) throw new Error(`/api/vs returned ${res.status}`);
    const data = await res.json();
    return { items: data.items ?? [], cache: data.cache ?? null };
  }
  return getAllVSDirect();
}

/** @deprecated use getUserVSFast */
export async function getUserVSSnapshot(
  address: string,
  opts?: { forceRefresh?: boolean }
): Promise<VSFeedSnapshot> {
  if (typeof window !== "undefined") {
    const suffix = opts?.forceRefresh ? "?refresh=1" : "";
    const res = await fetch(`/api/vs/user/${address}${suffix}`);
    if (!res.ok) throw new Error(`/api/vs/user returned ${res.status}`);
    const data = await res.json();
    return { items: data.items ?? [], cache: data.cache ?? null };
  }
  const items = await getUserVSSummaries(address);
  return { items: items.sort((a, b) => b.id - a.id), cache: makeLiveFreshness() };
}

/** Alias for cancelClaim — kept for page compatibility */
export async function cancelVS(
  wallet: string,
  claimId: number,
  _inviteKey = ""
): Promise<ClaimWriteResult> {
  return cancelClaim(wallet, claimId);
}

/** Alias for getUserVSSummaries — kept for page compatibility */
export async function getUserVSDirect(address: string): Promise<VSData[]> {
  return getUserVSSummaries(address);
}

/**
 * Traverse parent_id chain to build a rivalry chain.
 * Returns an array of claim IDs from root → all descendants (BFS).
 */
export async function getRivalryChain(claimId: number): Promise<number[]> {
  const visited = new Set<number>();
  const queue   = [claimId];
  const result: number[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    result.push(id);

    const claim = await readClaimRaw(id);
    if (!claim) continue;

    // Walk up to root
    if (claim.parent_id > 0 && !visited.has(claim.parent_id)) {
      queue.unshift(claim.parent_id);
    }
  }

  return result;
}

/**
 * Resolution is handled by the off-chain oracle agent automatically.
 * This stub is kept for UI compatibility — it no longer sends a transaction.
 */
export async function requestResolveVS(
  _wallet: string,
  _claimId: number,
  _inviteKey = ""
): Promise<ClaimWriteResult> {
  throw new Error(
    "Resolution is handled automatically by the Mimir oracle agent after the deadline. No user action required."
  );
}

/** Kept for UI compatibility — no-op. */
export async function resetVSResolveRequest(
  _wallet: string,
  _claimId: number,
  _inviteKey = ""
): Promise<ClaimWriteResult> {
  throw new Error("Not applicable — the oracle resolves automatically.");
}
