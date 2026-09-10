/**
 * paginatedGetLogs must never scan more than the recent window.
 *
 * The bug this guards: the scan was anchored to the deploy block, so its cost
 * grew with chain age. On Somnia (≈1M blocks/day) it had reached 9.6M blocks —
 * ~9,600 chunked requests — and /stats stopped answering while the production
 * build timed out exporting it.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { paginatedGetLogs, SOMNIA_LOG_CHUNK, SOMNIA_LOG_LOOKBACK } from "../../lib/chain";

/** Records the ranges asked for instead of talking to a chain. */
function spyClient(head: bigint) {
  const ranges: Array<{ from: bigint; to: bigint }> = [];
  return {
    ranges,
    client: {
      getBlockNumber: async () => head,
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        ranges.push({ from: fromBlock, to: toBlock });
        return [];
      },
    } as never,
  };
}

test("a deploy-block-anchored scan is clamped to the lookback window", async () => {
  const head = 484_982_622n;
  const deploy = 475_351_661n; // 9.6M blocks back — the real gap that broke /stats
  const { client, ranges } = spyClient(head);

  await paginatedGetLogs(client, { address: "0x0" } as never, deploy);

  const oldest = ranges.reduce((min, r) => (r.from < min ? r.from : min), head);
  assert.equal(oldest, head - SOMNIA_LOG_LOOKBACK, "scan must start at the window edge");
  assert.ok(
    ranges.length <= Number(SOMNIA_LOG_LOOKBACK / SOMNIA_LOG_CHUNK) + 1,
    `expected a bounded request count, got ${ranges.length}`,
  );
  assert.equal(ranges.at(-1)?.to, head, "the window must still reach the head");
});

test("a scan already inside the window is left alone", async () => {
  const head = 1_000_000n;
  const from = head - 500n;
  const { client, ranges } = spyClient(head);

  await paginatedGetLogs(client, { address: "0x0" } as never, from);

  assert.equal(ranges.length, 1);
  assert.deepEqual(ranges[0], { from, to: head });
});

test("no request exceeds the RPC's 1000-block ceiling", async () => {
  const head = 2_000_000n;
  const { client, ranges } = spyClient(head);

  await paginatedGetLogs(client, { address: "0x0" } as never, head - 5_000n);

  for (const r of ranges) {
    assert.ok(r.to - r.from < 1000n, `range ${r.from}-${r.to} spans ${r.to - r.from}`);
  }
});
