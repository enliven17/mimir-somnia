/**
 * Settlement projection — rebuilds market_settlements / fee_accruals / fee_claims
 * from MarketSettled, FeeAccrued and FeeClaimed logs.
 *
 * /revenue read these tables and they had no writer at all, so the market half of
 * the dashboard reported zero however many markets had actually settled on chain.
 * The chain is still the record; this is only the projection that makes it
 * queryable.
 *
 * Every write is idempotent (ON CONFLICT on the log's tx+index), so a replayed
 * range cannot double-count revenue — which is what lets the cursor be a plain
 * high-water mark instead of a transaction.
 */

import { parseAbiItem, type Log } from "viem";

import {
  createSomniaPublicClient,
  getContractAddress,
  isContractConfigured,
  SOMNIA_LOG_CHUNK,
} from "@/lib/chain";
import {
  getSyncMeta,
  insertFeeAccrual,
  insertFeeClaim,
  isDbConfigured,
  setSyncMeta,
  upsertMarketSettlement,
} from "@/lib/db";

const CURSOR_KEY = "settlement_cursor_block";

/**
 * The Somnia testnet RPC caps eth_getLogs at 1000 blocks and says so only by
 * rejecting the call, so this shares lib/chain's single SOMNIA_LOG_CHUNK knob
 * rather than keeping its own copy of the number — a local 5k constant here made
 * every sync poll fail while the rest of the app was already within the cap.
 */
const CHUNK_BLOCKS = SOMNIA_LOG_CHUNK;

/** A cold start walks from the deploy block; there is nothing older to find. */
function deployBlock(): bigint {
  const raw = Number(process.env.NEXT_PUBLIC_DEPLOY_BLOCK ?? "0");
  return Number.isFinite(raw) && raw > 0 ? BigInt(Math.floor(raw)) : 0n;
}

const MARKET_SETTLED = parseAbiItem(
  "event MarketSettled(uint256 indexed id, uint256 totalPaid, uint256 totalFees, uint256 dust)",
);
const FEE_ACCRUED = parseAbiItem(
  "event FeeAccrued(uint256 indexed id, address indexed recipient, uint256 amount, bool isAgentOwnerFee)",
);
const FEE_CLAIMED = parseAbiItem(
  "event FeeClaimed(address indexed recipient, uint256 amount)",
);

export interface SettlementSyncResult {
  settlements: number;
  accruals: number;
  claims: number;
  fromBlock: number;
  toBlock: number;
}

type SettledLog = Log<bigint, number, false, typeof MARKET_SETTLED>;
type AccruedLog = Log<bigint, number, false, typeof FEE_ACCRUED>;

/**
 * Split one claim's accruals into the two fee buckets the dashboard reports.
 * Pure so the arithmetic can be tested without a chain or a database.
 */
export function splitFees(accruals: Array<{ amount: bigint; isAgentOwnerFee: boolean }>): {
  platformAtomic: bigint;
  agentOwnerAtomic: bigint;
} {
  let platformAtomic = 0n;
  let agentOwnerAtomic = 0n;
  for (const a of accruals) {
    if (a.isAgentOwnerFee) agentOwnerAtomic += a.amount;
    else platformAtomic += a.amount;
  }
  return { platformAtomic, agentOwnerAtomic };
}

/**
 * Gross volume is what the contract took in, so it is everything it then moved
 * out: winner payouts, fees and the rounding dust it kept.
 */
export function grossVolume(totalPaid: bigint, totalFees: bigint, dust: bigint): bigint {
  return totalPaid + totalFees + dust;
}

export async function reconcileSettlements(): Promise<SettlementSyncResult> {
  const empty = { settlements: 0, accruals: 0, claims: 0, fromBlock: 0, toBlock: 0 };
  if (!isDbConfigured() || !isContractConfigured()) return empty;

  const client = createSomniaPublicClient();
  const address = getContractAddress();
  const head = await client.getBlockNumber();

  const stored = Number(await getSyncMeta(CURSOR_KEY).catch(() => null));
  const cursor = Number.isFinite(stored) && stored > 0 ? BigInt(stored) : deployBlock();
  // Re-read the cursor block itself: a range that ended mid-block would otherwise
  // drop the logs after the one we happened to stop on.
  let from = cursor;
  if (from > head) return { ...empty, fromBlock: Number(from), toBlock: Number(head) };

  const result: SettlementSyncResult = {
    settlements: 0, accruals: 0, claims: 0, fromBlock: Number(from), toBlock: Number(head),
  };
  const blockTimes = new Map<bigint, number>();
  const timestampOf = async (blockNumber: bigint): Promise<number> => {
    const cached = blockTimes.get(blockNumber);
    if (cached !== undefined) return cached;
    const block = await client.getBlock({ blockNumber });
    const at = Number(block.timestamp);
    blockTimes.set(blockNumber, at);
    return at;
  };

  while (from <= head) {
    const to = from + CHUNK_BLOCKS - 1n > head ? head : from + CHUNK_BLOCKS - 1n;

    const [settled, accrued, claimed] = await Promise.all([
      client.getLogs({ address, event: MARKET_SETTLED, fromBlock: from, toBlock: to }),
      client.getLogs({ address, event: FEE_ACCRUED, fromBlock: from, toBlock: to }),
      client.getLogs({ address, event: FEE_CLAIMED, fromBlock: from, toBlock: to }),
    ]);

    // Grouped by claim so a settlement can find its own fee legs; they are emitted
    // in the same transaction but not necessarily adjacent.
    const accrualsByClaim = new Map<string, Array<{ amount: bigint; isAgentOwnerFee: boolean }>>();
    for (const log of accrued as AccruedLog[]) {
      const id = log.args.id;
      const amount = log.args.amount;
      if (id === undefined || amount === undefined) continue;
      const key = id.toString();
      const bucket = accrualsByClaim.get(key) ?? [];
      bucket.push({ amount, isAgentOwnerFee: Boolean(log.args.isAgentOwnerFee) });
      accrualsByClaim.set(key, bucket);

      await insertFeeAccrual({
        accrual_id: `${log.transactionHash}:${log.logIndex}`,
        claim_id: Number(id),
        recipient: log.args.recipient ?? "0x0000000000000000000000000000000000000000",
        source: log.args.isAgentOwnerFee ? "agent_owner" : "platform",
        amount_atomic: amount,
        transaction_hash: log.transactionHash ?? "",
        log_index: log.logIndex ?? 0,
        accrued_at: await timestampOf(log.blockNumber),
      });
      result.accruals += 1;
    }

    for (const log of settled as SettledLog[]) {
      const id = log.args.id;
      if (id === undefined) continue;
      const totalPaid = log.args.totalPaid ?? 0n;
      const totalFees = log.args.totalFees ?? 0n;
      const dust = log.args.dust ?? 0n;
      const { platformAtomic, agentOwnerAtomic } = splitFees(accrualsByClaim.get(id.toString()) ?? []);

      await upsertMarketSettlement({
        claim_id: Number(id),
        gross_volume_atomic: grossVolume(totalPaid, totalFees, dust),
        payout_atomic: totalPaid,
        // The event's totalFees is authoritative; the split only says who got what,
        // so a missed FeeAccrued log cannot make fees vanish from the total.
        platform_fee_atomic: agentOwnerAtomic === 0n && platformAtomic === 0n ? totalFees : platformAtomic,
        agent_owner_fee_atomic: agentOwnerAtomic,
        dust_atomic: dust,
        transaction_hash: log.transactionHash ?? "",
        settled_at: await timestampOf(log.blockNumber),
      });
      result.settlements += 1;
    }

    for (const log of claimed) {
      const amount = log.args.amount;
      if (amount === undefined) continue;
      await insertFeeClaim({
        claim_event_id: `${log.transactionHash}:${log.logIndex}`,
        recipient: log.args.recipient ?? "0x0000000000000000000000000000000000000000",
        amount_atomic: amount,
        transaction_hash: log.transactionHash ?? "",
        log_index: log.logIndex ?? 0,
        claimed_at: await timestampOf(log.blockNumber),
      });
      result.claims += 1;
    }

    // Advance only after the chunk's writes land: crashing mid-chunk replays it,
    // and replaying is free because every write is idempotent.
    await setSyncMeta(CURSOR_KEY, to.toString());
    from = to + 1n;
  }

  return result;
}
