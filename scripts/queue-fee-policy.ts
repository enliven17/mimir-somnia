/**
 * Queue Mimir's fee policy on chain, then execute it once the timelock elapses.
 *
 *   npx tsx --env-file-if-exists=.env.local scripts/queue-fee-policy.ts
 *   npx tsx --env-file-if-exists=.env.local scripts/queue-fee-policy.ts --execute
 *   npx tsx --env-file-if-exists=.env.local scripts/queue-fee-policy.ts --status
 *
 * MimirV2 enforces a two-day notice between queueing and executing, so this is
 * deliberately two runs rather than one. Execution is permissionless afterwards —
 * a lost owner key must not be able to strand a change that was already announced.
 *
 * Rates come from FEE_SCHEDULE so the published number, the accounting module and
 * the chain cannot drift apart.
 */

import { parseAbi } from "viem";

import { createSomniaPublicClient, getContractAddress, getExplorerTxUrl } from "../lib/chain";
import { loadAgentWallet } from "../lib/agent-wallets";
import { FEE_SCHEDULE } from "../lib/fees";

const ABI = parseAbi([
  "function feePolicy() view returns (uint16 platformFeeBps, uint16 agentOwnerFeeBps, address platformRecipient)",
  "function pendingFeePolicy() view returns (uint16 platformFeeBps, uint16 agentOwnerFeeBps, address platformRecipient, uint256 executableAt, bool exists)",
  "function queueFeePolicy(uint16 _platformFeeBps, uint16 _agentOwnerFeeBps, address _platformRecipient)",
  "function executeFeePolicy()",
]);

function recipient(): `0x${string}` {
  const raw = process.env.PLATFORM_FEE_RECIPIENT?.trim();
  if (!raw || !/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new Error("PLATFORM_FEE_RECIPIENT must be a valid address");
  }
  return raw as `0x${string}`;
}

async function main(): Promise<void> {
  const mode = process.argv.includes("--execute") ? "execute"
    : process.argv.includes("--status") ? "status" : "queue";
  const client = createSomniaPublicClient();
  const address = getContractAddress();

  const [active, pending] = await Promise.all([
    client.readContract({ address, abi: ABI, functionName: "feePolicy" }),
    client.readContract({ address, abi: ABI, functionName: "pendingFeePolicy" }),
  ]);

  console.log("Active   :", `platform ${active[0]}bps · agentOwner ${active[1]}bps · ${active[2]}`);
  if (pending[4]) {
    const at = new Date(Number(pending[3]) * 1000);
    const ready = Date.now() >= at.getTime();
    console.log("Pending  :", `platform ${pending[0]}bps · agentOwner ${pending[1]}bps · ${pending[2]}`);
    console.log("Executable:", at.toISOString(), ready ? "(ready now)" : "(timelock still running)");
  } else {
    console.log("Pending  : none");
  }
  if (mode === "status") return;

  const owner = loadAgentWallet("ORACLE_PRIVATE_KEY");

  if (mode === "execute") {
    if (!pending[4]) throw new Error("nothing queued to execute");
    if (Date.now() < Number(pending[3]) * 1000) {
      throw new Error(`timelock has not elapsed — executable at ${new Date(Number(pending[3]) * 1000).toISOString()}`);
    }
    const hash = await owner.client.writeContract({
      account: owner.account, address, abi: ABI, functionName: "executeFeePolicy", args: [], chain: null,
    });
    await client.waitForTransactionReceipt({ hash });
    console.log("\nExecuted:", getExplorerTxUrl(hash));
    return;
  }

  console.log(`\nQueueing platform ${FEE_SCHEDULE.platformBps}bps + agentOwner ${FEE_SCHEDULE.agentOwnerBps}bps → ${recipient()}`);
  const hash = await owner.client.writeContract({
    account: owner.account, address, abi: ABI, functionName: "queueFeePolicy",
    args: [FEE_SCHEDULE.platformBps, FEE_SCHEDULE.agentOwnerBps, recipient()],
    chain: null,
  });
  await client.waitForTransactionReceipt({ hash });
  console.log("Queued:", getExplorerTxUrl(hash));
  console.log("Run again with --execute once the two-day timelock has elapsed.");
}

main().catch((err) => {
  console.error("queue-fee-policy failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
