import assert from "node:assert/strict";
import test from "node:test";
import { agentRequestMessage, validateAgentRequestEnvelope, type SignedAgentRequest } from "../../lib/agents/api";

const NOW = 1_780_000_000_000;
function request(overrides: Partial<SignedAgentRequest> = {}): SignedAgentRequest {
  return { version: "v1", agentId: "sandbox-agent", action: "heartbeat",
    idempotencyKey: "heartbeat-1", nonce: "nonce-1", signedAt: NOW,
    body: { b: 2, a: 1 }, signature: "0x12", ...overrides };
}

test("signed request body hashing is canonical across object key order", () => {
  const a = request({ body: { a: 1, b: 2 } });
  const b = request({ body: { b: 2, a: 1 } });
  assert.equal(agentRequestMessage(a), agentRequestMessage(b));
  assert.match(agentRequestMessage(a), /bodyHash: 0x[0-9a-f]{64}/);
});

test("request envelope is versioned, timestamped and nonce/idempotency bound", () => {
  assert.deepEqual(validateAgentRequestEnvelope(request(), NOW), []);
  assert.match(validateAgentRequestEnvelope(request({ signedAt: NOW - 6 * 60_000 }), NOW).join(" "), /timestamp/);
  assert.match(validateAgentRequestEnvelope(request({ nonce: "" }), NOW).join(" "), /nonce/);
  assert.match(validateAgentRequestEnvelope(request({ idempotencyKey: "" }), NOW).join(" "), /idempotency/);
});

test("the signature message binds action and idempotency key", () => {
  assert.notEqual(agentRequestMessage(request()), agentRequestMessage(request({ action: "stake" })));
  assert.notEqual(agentRequestMessage(request()), agentRequestMessage(request({ idempotencyKey: "heartbeat-2" })));
});
