import assert from "node:assert/strict";
import test from "node:test";

import { apiError, isRetryable, statusFor, type ApiErrorCode } from "../../lib/api/errors";
import {
  CLOCK_SKEW_MS,
  REQUEST_TTL_MS,
  SIGNED_REQUEST_VERSION,
  bodyHash,
  canonicalRequestDigest,
  checkIdempotency,
  verifySignedRequest,
  type IdempotencyRecord,
  type SignedRequestEnvelope,
} from "../../lib/api/signed-request";
import {
  DEFAULT_RULES,
  consume,
  peek,
  resetRateLimits,
  type LimitRule,
} from "../../lib/api/rate-limit";

const OPERATOR = "0xBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbb";
const OTHER = "0xCCccCCccCCccCCccCCccCCccCCccCCccCCccCCcc";
const CHAIN = 84532;
const NOW = 1_780_000_000_000;
const BODY = '{"claimId":12,"stakeUsdc":5}';

function envelope(overrides: Partial<SignedRequestEnvelope> = {}): SignedRequestEnvelope {
  return {
    version: SIGNED_REQUEST_VERSION,
    agentId: "acme-forecaster",
    operatorWallet: OPERATOR,
    method: "POST",
    path: "/api/agent/stake",
    nonce: "n-1",
    timestamp: NOW,
    chainId: CHAIN,
    bodyHash: bodyHash(BODY),
    ...overrides,
  };
}

function verify(
  overrides: Partial<Parameters<typeof verifySignedRequest>[0]> = {},
) {
  return verifySignedRequest({
    envelope: envelope(),
    rawBody: BODY,
    actualMethod: "POST",
    actualPath: "/api/agent/stake",
    expectedChainId: CHAIN,
    recoveredWallet: OPERATOR,
    registeredOperatorWallet: OPERATOR,
    usedNonces: new Set(),
    now: NOW + 1_000,
    ...overrides,
  });
}

// ── Error contract: agents cannot read prose ──────────────────────────────────

test("a malformed request is NOT retryable", () => {
  // Marking these retryable is how a fleet turns one bug into a self-DoS.
  for (const code of [
    "invalid_request",
    "invalid_signature",
    "unsupported_version",
    "unauthenticated",
    "nonce_reused",
    "forbidden",
    "capability_missing",
    "agent_revoked",
    "not_found",
    "conflict",
    "idempotency_conflict",
  ] as ApiErrorCode[]) {
    assert.equal(isRetryable(code), false, `${code} must not invite a retry`);
  }
});

test("transient conditions are retryable", () => {
  for (const code of [
    "rate_limited",
    "budget_exhausted",
    "upstream_unavailable",
    "internal_error",
    "agent_paused",
    "request_expired",
  ] as ApiErrorCode[]) {
    assert.equal(isRetryable(code), true, `${code} should be retryable`);
  }
});

test("revoked is permanent while paused is not", () => {
  // Paused is an operator action that can be undone; revoked is terminal.
  assert.equal(isRetryable("agent_revoked"), false);
  assert.equal(isRetryable("agent_paused"), true);
});

test("statuses map to the right HTTP codes", () => {
  assert.equal(statusFor("invalid_request"), 400);
  assert.equal(statusFor("unauthenticated"), 401);
  assert.equal(statusFor("forbidden"), 403);
  assert.equal(statusFor("not_found"), 404);
  assert.equal(statusFor("idempotency_conflict"), 409);
  assert.equal(statusFor("rate_limited"), 429);
  assert.equal(statusFor("budget_exhausted"), 429);
  assert.equal(statusFor("internal_error"), 500);
  assert.equal(statusFor("upstream_unavailable"), 503);
});

test("Retry-After is only sent when waiting can help", () => {
  assert.equal(apiError("invalid_request", "bad").headers["retry-after"], undefined);
  assert.equal(apiError("rate_limited", "slow down").headers["retry-after"], "60");
  assert.equal(apiError("budget_exhausted", "spent").headers["retry-after"], "3600");
});

test("an override retry delay is honoured and rounded up", () => {
  const result = apiError("rate_limited", "slow", { retryAfterSeconds: 2.2 });
  assert.equal(result.headers["retry-after"], "3");
  assert.equal(result.body.error.retryAfterSeconds, 2.2);
});

test("a validation error can name the offending field", () => {
  const result = apiError("invalid_request", "stake too small", { field: "stakeUsdc" });
  assert.equal(result.body.error.field, "stakeUsdc");
  assert.equal(result.body.error.code, "invalid_request");
  assert.equal(result.body.error.retryable, false);
});

// ── Signed requests ───────────────────────────────────────────────────────────

test("a well-formed fresh signed request verifies", () => {
  assert.deepEqual(verify(), { ok: true });
});

test("the digest covers method and path, so a body cannot be replayed elsewhere", () => {
  // Signing only the body would let a valid "stake 5" be replayed at /withdraw.
  const base = canonicalRequestDigest(envelope());
  assert.notEqual(base, canonicalRequestDigest(envelope({ path: "/api/agent/withdraw" })));
  assert.notEqual(base, canonicalRequestDigest(envelope({ method: "DELETE" })));
});

test("the digest covers the nonce, timestamp, chain and idempotency key", () => {
  const base = canonicalRequestDigest(envelope());
  assert.notEqual(base, canonicalRequestDigest(envelope({ nonce: "n-2" })));
  assert.notEqual(base, canonicalRequestDigest(envelope({ timestamp: NOW + 1 })));
  assert.notEqual(base, canonicalRequestDigest(envelope({ chainId: 8453 })));
  assert.notEqual(base, canonicalRequestDigest(envelope({ idempotencyKey: "k1" })));
});

test("field boundaries cannot be forged in the digest", () => {
  // agentId "a" + path "/b" must not equal agentId "a/b" + path "".
  assert.notEqual(
    canonicalRequestDigest(envelope({ agentId: "a", path: "/b" })),
    canonicalRequestDigest(envelope({ agentId: "a/b", path: "" })),
  );
});

test("a request served on a different path is rejected", () => {
  const result = verify({ actualPath: "/api/agent/withdraw" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_request");
  assert.match(result.detail ?? "", /path does not match/);
});

test("a request served with a different method is rejected", () => {
  assert.equal(verify({ actualMethod: "GET" }).reason, "invalid_request");
});

test("a tampered body is rejected — the BYTES were signed, not the parsed object", () => {
  const result = verify({ rawBody: '{"claimId":12,"stakeUsdc":500}' });
  assert.equal(result.ok, false);
  assert.match(result.detail ?? "", /body does not match/);
});

test("whitespace-only body changes still fail, because bytes are hashed", () => {
  // Two byte strings can parse to the same object; only one was signed.
  assert.equal(verify({ rawBody: '{"claimId":12, "stakeUsdc":5}' }).ok, false);
});

test("an expired request is rejected but marked retryable", () => {
  const result = verify({ now: NOW + REQUEST_TTL_MS + 1 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "request_expired");
  // A fresh request WOULD work, so a retry with a new timestamp is correct.
  assert.equal(isRetryable("request_expired"), true);
});

test("a timestamp beyond the clock-skew tolerance is rejected", () => {
  assert.equal(verify({ now: NOW - CLOCK_SKEW_MS - 1 }).reason, "request_expired");
  // Inside the tolerance is fine — client clocks drift.
  assert.equal(verify({ now: NOW - CLOCK_SKEW_MS + 1_000 }).ok, true);
});

test("a replayed nonce is rejected", () => {
  const result = verify({ usedNonces: new Set(["n-1"]) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "nonce_reused");
});

test("a signature from the wrong wallet is rejected", () => {
  assert.equal(verify({ recoveredWallet: OTHER }).reason, "invalid_signature");
});

test("a signature from a key the registry does not know is rejected", () => {
  // Otherwise anyone could sign as any agent by naming their own wallet.
  const result = verify({
    recoveredWallet: OTHER,
    envelope: envelope({ operatorWallet: OTHER }),
    registeredOperatorWallet: OPERATOR,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "forbidden");
  assert.match(result.detail ?? "", /registered operator/);
});

test("a signature for another chain authorises nothing here", () => {
  const result = verify({ envelope: envelope({ chainId: 8453 }) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "forbidden");
});

test("an unknown envelope version is rejected rather than guessed at", () => {
  assert.equal(verify({ envelope: envelope({ version: 99 }) }).reason, "unsupported_version");
});

test("an incomplete envelope is rejected", () => {
  for (const bad of [{ agentId: "" }, { nonce: "" }, { operatorWallet: "" }]) {
    assert.equal(verify({ envelope: envelope(bad) }).reason, "invalid_request");
  }
});

test("an empty body hashes to the empty string, not to a hash of nothing", () => {
  assert.equal(bodyHash(""), "");
  assert.equal(
    verify({
      rawBody: "",
      envelope: envelope({ bodyHash: "" }),
    }).ok,
    true,
  );
});

// ── Idempotency ───────────────────────────────────────────────────────────────

function store(records: IdempotencyRecord[]): Map<string, IdempotencyRecord> {
  return new Map(records.map((record) => [record.key, record]));
}

test("no key means just proceed", () => {
  assert.deepEqual(checkIdempotency(undefined, bodyHash(BODY), store([])), { kind: "proceed" });
});

test("an unseen key proceeds", () => {
  assert.deepEqual(checkIdempotency("k1", bodyHash(BODY), store([])), { kind: "proceed" });
});

test("the same key and body replays the stored response instead of acting twice", () => {
  const outcome = checkIdempotency(
    "k1",
    bodyHash(BODY),
    store([
      {
        key: "k1",
        bodyHash: bodyHash(BODY),
        response: { status: 200, body: { ok: true } },
        createdAt: NOW,
      },
    ]),
  );
  assert.equal(outcome.kind, "replay");
  assert.deepEqual(
    outcome.kind === "replay" ? outcome.response : null,
    { status: 200, body: { ok: true } },
  );
});

test("the same key while the original is still running reports in_flight", () => {
  const outcome = checkIdempotency(
    "k1",
    bodyHash(BODY),
    store([{ key: "k1", bodyHash: bodyHash(BODY), createdAt: NOW }]),
  );
  assert.equal(outcome.kind, "in_flight");
});

test("the same key with a DIFFERENT body is a conflict, never a guess", () => {
  // Guessing which request was meant could double-spend.
  const outcome = checkIdempotency(
    "k1",
    bodyHash('{"claimId":13}'),
    store([{ key: "k1", bodyHash: bodyHash(BODY), createdAt: NOW }]),
  );
  assert.equal(outcome.kind, "conflict");
  assert.equal(isRetryable("idempotency_conflict"), false);
});

// ── Rate limiting ─────────────────────────────────────────────────────────────

const rule = (dimension: LimitRule["dimension"], limit: number): LimitRule => ({
  dimension,
  limit,
  windowMs: 60_000,
});

test("requests are allowed up to the limit, then refused", () => {
  resetRateLimits();
  const rules = [rule("agent", 2)];
  assert.equal(consume({ agentId: "a" }, rules, NOW).allowed, true);
  assert.equal(consume({ agentId: "a" }, rules, NOW).allowed, true);
  const third = consume({ agentId: "a" }, rules, NOW);
  assert.equal(third.allowed, false);
  assert.equal(third.exceeded, "agent");
  assert.ok((third.retryAfterSeconds ?? 0) > 0);
});

test("the refusal names WHICH dimension was hit", () => {
  // "rate limited" alone cannot tell an agent whether to slow down or stop.
  resetRateLimits();
  const rules = [rule("ip", 100), rule("agent", 1)];
  consume({ ip: "1.2.3.4", agentId: "a" }, rules, NOW);
  const refused = consume({ ip: "1.2.3.4", agentId: "a" }, rules, NOW);
  assert.equal(refused.exceeded, "agent");
});

test("a refused request does not consume budget, so a burst cannot lock a key out", () => {
  resetRateLimits();
  const rules = [rule("agent", 1)];
  consume({ agentId: "a" }, rules, NOW);
  // Ten refusals inside the window…
  for (let i = 0; i < 10; i += 1) consume({ agentId: "a" }, rules, NOW);
  // …and the window still resets on schedule.
  assert.equal(consume({ agentId: "a" }, rules, NOW + 60_001).allowed, true);
});

test("buckets are independent per key", () => {
  resetRateLimits();
  const rules = [rule("agent", 1)];
  assert.equal(consume({ agentId: "a" }, rules, NOW).allowed, true);
  assert.equal(consume({ agentId: "b" }, rules, NOW).allowed, true);
  assert.equal(consume({ agentId: "a" }, rules, NOW).allowed, false);
});

test("a wallet key is case-insensitive", () => {
  resetRateLimits();
  const rules = [rule("wallet", 1)];
  consume({ wallet: OPERATOR }, rules, NOW);
  assert.equal(consume({ wallet: OPERATOR.toLowerCase() }, rules, NOW).allowed, false);
});

test("an absent dimension is not counted, so anonymous callers do not share a bucket", () => {
  // Substituting a placeholder would let one anonymous caller exhaust everyone.
  resetRateLimits();
  const rules = [rule("agent", 1)];
  assert.equal(consume({ ip: "1.1.1.1" }, rules, NOW).allowed, true);
  assert.equal(consume({ ip: "2.2.2.2" }, rules, NOW).allowed, true);
  assert.equal(consume({ ip: "3.3.3.3" }, rules, NOW).allowed, true);
});

test("the window resets", () => {
  resetRateLimits();
  const rules = [rule("agent", 1)];
  consume({ agentId: "a" }, rules, NOW);
  assert.equal(consume({ agentId: "a" }, rules, NOW + 59_999).allowed, false);
  assert.equal(consume({ agentId: "a" }, rules, NOW + 60_000).allowed, true);
});

test("remaining reports the tightest bucket", () => {
  resetRateLimits();
  const rules = [rule("ip", 100), rule("agent", 3)];
  const decision = consume({ ip: "1.2.3.4", agentId: "a" }, rules, NOW);
  assert.equal(decision.remaining, 2);
});

test("peek does not consume", () => {
  resetRateLimits();
  const rules = [rule("agent", 5)];
  consume({ agentId: "a" }, rules, NOW);
  const before = peek({ agentId: "a" }, rules, NOW);
  peek({ agentId: "a" }, rules, NOW);
  const after = peek({ agentId: "a" }, rules, NOW);
  assert.deepEqual(before, after);
  assert.equal(after.agent.used, 1);
  assert.equal(after.agent.limit, 5);
});

test("the default rules cover all four dimensions", () => {
  assert.deepEqual(
    DEFAULT_RULES.map((r) => r.dimension).sort(),
    ["agent", "ip", "route", "wallet"],
  );
});
