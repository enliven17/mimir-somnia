import assert from "node:assert/strict";
import test from "node:test";

import { EvidenceFetchError, fetchEvidence } from "../../lib/server/evidence-fetcher";

/**
 * The URL reaching fetchEvidence is attacker-chosen on both paths: a claim's
 * resolutionUrl is whatever its creator wrote on chain, and /api/claim-draft takes
 * one from a request body. The oracle process holds every agent key, so a fetch it
 * can be steered into is the sharpest edge in the system.
 *
 * These assert the refusal happens before any socket is opened — a guard that only
 * rejects after the request has already hit the metadata service is not a guard.
 */

const BLOCKED = [
  ["cloud metadata", "http://169.254.169.254/computeMetadata/v1/"],
  ["loopback", "http://127.0.0.1:8080/api/health"],
  ["loopback by name", "http://localhost:3000/"],
  ["private class A", "http://10.0.0.5/"],
  ["private class C", "http://192.168.1.1/admin"],
  ["ipv6 loopback", "http://[::1]/"],
] as const;

for (const [label, url] of BLOCKED) {
  test(`refuses to fetch ${label}`, async () => {
    let fetched = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetched = true;
      throw new Error("fetch must not be reached");
    }) as typeof fetch;
    try {
      await assert.rejects(
        () => fetchEvidence(url),
        (err: unknown) => err instanceof EvidenceFetchError,
        `${url} should be refused`,
      );
      assert.equal(fetched, false, "guard ran too late — a request was already sent");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
}

test("a non-http scheme is refused before anything else", async () => {
  await assert.rejects(() => fetchEvidence("file:///etc/passwd"), EvidenceFetchError);
  await assert.rejects(() => fetchEvidence("gopher://127.0.0.1/"), EvidenceFetchError);
});
