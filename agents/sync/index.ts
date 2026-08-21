/**
 * Mimir Read-Index Sync Worker
 *
 * Reconciles the Neon read index against on-chain state. Contract state is the
 * source of truth; this keeps /explorer, /dashboard and the VS APIs from serving
 * stale claims, and it is the `sync` worker /api/health monitors.
 *
 * Lives in the worker fleet rather than behind a platform cron: Railway already
 * runs this fleet as a long-lived process, so an in-process interval needs no
 * scheduler, no HTTP hop and no shared secret to go wrong.
 *
 * Run: npx tsx agents/sync/index.ts
 * Env: DATABASE_URL, NEXT_PUBLIC_CONTRACT_ADDRESS, SOMNIA_RPC_URL
 *      SYNC_POLL_INTERVAL_MS=300000 (poll cadence in ms, default 5m)
 */

import { reportingPoll } from "../../lib/ops/heartbeat";
import { reconcileSettlements } from "../../lib/server/settlement-index";
import { reconcileVsIndex } from "../../lib/server/vs-index";

// Default 5m: the health probe warns when the index is over 300s stale, so a
// slower cadence would report a working sync as degraded.
const POLL_INTERVAL_MS = Number(process.env.SYNC_POLL_INTERVAL_MS ?? "300000");

async function poll(): Promise<void> {
  const summary = await reconcileVsIndex();
  console.log(
    `[sync] ── Reconciled at ${new Date().toISOString()} — ` +
      `${summary.synced} synced, ${summary.new} new, ${summary.stateChanges} state change(s)`,
  );

  // Settlement/fee projection for /revenue. Runs after the claim index so a market
  // that just resolved is already indexed when its settlement row appears.
  const fees = await reconcileSettlements();
  console.log(
    `[sync]    settlements: ${fees.settlements} market(s), ${fees.accruals} accrual(s), ` +
      `${fees.claims} claim(s) · blocks ${fees.fromBlock}→${fees.toBlock}`,
  );
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required — the read index has nowhere to live");
  }

  console.log("═══════════════════════════════════════════════");
  console.log("  Mimir Read-Index Sync Worker");
  console.log(`  Contract   : ${process.env.NEXT_PUBLIC_CONTRACT_ADDRESS}`);
  console.log(`  Poll every : ${POLL_INTERVAL_MS / 1000}s`);
  console.log("═══════════════════════════════════════════════\n");

  // Reports a heartbeat either way, so a crash-looping sync shows as alive and
  // failing on /api/health rather than merely stale.
  const safePoll = () => reportingPoll("sync", "sync", POLL_INTERVAL_MS / 1000, poll);

  await safePoll();
  setInterval(safePoll, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("[sync] Fatal:", err);
  process.exit(1);
});
