/**
 * Signed agent requests.
 *
 * Any endpoint that moves money or changes authority must prove three things
 * before it acts:
 *
 *   who    a wallet signature over the request
 *   once   a nonce, so a captured request cannot be replayed
 *   fresh  a timestamp, so an old capture cannot be replayed later either
 *
 * A nonce alone is not enough: without expiry the server must remember every
 * nonce forever. A timestamp alone is not enough either: inside the freshness
 * window a captured request could be replayed repeatedly. Both together bound the
 * replay set to one window, so the nonce store can be a small TTL cache.
 *
 * The signature covers a canonical digest of METHOD, PATH, BODY, nonce, timestamp
 * and chain id. Signing only the body would let an attacker replay a valid
 * "stake 5 USDC" body against a different route.
 */

import { keccak256, toBytes } from "viem";

export const SIGNED_REQUEST_VERSION = 1;

/** How long a signed request stays valid. */
export const REQUEST_TTL_MS = 60_000;
/** Tolerance for a client clock running ahead of ours. */
export const CLOCK_SKEW_MS = 10_000;

export interface SignedRequestEnvelope {
  version: number;
  /** Registry id of the calling agent. */
  agentId: string;
  /** Wallet that produced the signature — the agent's operator key. */
  operatorWallet: string;
  method: string;
  path: string;
  /** Single-use value. */
  nonce: string;
  /** Client-side epoch ms. */
  timestamp: number;
  chainId: number;
  /** keccak256 of the raw request body; empty string when there is no body. */
  bodyHash: string;
  /** Caller-chosen key that makes a retry safe. */
  idempotencyKey?: string;
}

/**
 * Canonical digest the agent signs.
 *
 * Field-separated with a character that cannot appear in a method, path, hex hash
 * or nonce, so no field value can forge a boundary and make two different
 * requests produce the same digest.
 */
const FIELD_SEPARATOR = String.fromCharCode(0x1f);

export function canonicalRequestDigest(envelope: SignedRequestEnvelope): `0x${string}` {
  const canonical = [
    "mimir-signed-request",
    String(envelope.version),
    envelope.agentId,
    envelope.operatorWallet.toLowerCase(),
    envelope.method.toUpperCase(),
    envelope.path,
    envelope.nonce,
    String(envelope.timestamp),
    String(envelope.chainId),
    envelope.bodyHash,
    envelope.idempotencyKey ?? "",
  ].join(FIELD_SEPARATOR);
  return keccak256(toBytes(canonical));
}

export function bodyHash(raw: string): string {
  return raw.length === 0 ? "" : keccak256(toBytes(raw));
}

export type SignedRequestRejection =
  | "unsupported_version"
  | "invalid_request"
  | "request_expired"
  | "nonce_reused"
  | "invalid_signature"
  | "forbidden";

export interface VerifyResult {
  ok: boolean;
  reason?: SignedRequestRejection;
  detail?: string;
}

export interface VerifySignedRequestArgs {
  envelope: SignedRequestEnvelope;
  /** Raw request body exactly as received — hashed, not parsed. */
  rawBody: string;
  /** Method and path the server actually served. */
  actualMethod: string;
  actualPath: string;
  expectedChainId: number;
  /** Wallet recovered from the signature by the caller. */
  recoveredWallet: string;
  /** Operator wallet the registry has on file for this agent. */
  registeredOperatorWallet: string;
  /** Nonces already consumed inside the freshness window. */
  usedNonces: ReadonlySet<string>;
  now?: number;
}

/**
 * Verify everything except the cryptography, which the caller does with viem.
 *
 * Pure, so every rejection path is testable without signing keys.
 */
export function verifySignedRequest(args: VerifySignedRequestArgs): VerifyResult {
  const { envelope } = args;
  const now = args.now ?? Date.now();

  if (envelope.version !== SIGNED_REQUEST_VERSION) {
    return {
      ok: false,
      reason: "unsupported_version",
      detail: `expected version ${SIGNED_REQUEST_VERSION}`,
    };
  }
  if (!envelope.agentId || !envelope.nonce || !envelope.operatorWallet) {
    return { ok: false, reason: "invalid_request", detail: "incomplete envelope" };
  }
  if (envelope.chainId !== args.expectedChainId) {
    // A signature for another chain must not authorise anything here.
    return { ok: false, reason: "forbidden", detail: "wrong chain" };
  }

  // Method and path are signed, so a valid body cannot be replayed elsewhere.
  if (envelope.method.toUpperCase() !== args.actualMethod.toUpperCase()) {
    return { ok: false, reason: "invalid_request", detail: "method does not match the signature" };
  }
  if (envelope.path !== args.actualPath) {
    return { ok: false, reason: "invalid_request", detail: "path does not match the signature" };
  }

  // The body is hashed, never trusted as parsed JSON: two different byte strings
  // can parse to the same object, and it is the bytes that were signed.
  if (envelope.bodyHash !== bodyHash(args.rawBody)) {
    return { ok: false, reason: "invalid_request", detail: "body does not match the signature" };
  }

  if (now - envelope.timestamp > REQUEST_TTL_MS) {
    return { ok: false, reason: "request_expired", detail: "request is too old" };
  }
  if (envelope.timestamp - now > CLOCK_SKEW_MS) {
    return { ok: false, reason: "request_expired", detail: "request timestamp is in the future" };
  }
  if (args.usedNonces.has(envelope.nonce)) {
    return { ok: false, reason: "nonce_reused", detail: "nonce already used" };
  }

  if (args.recoveredWallet.toLowerCase() !== envelope.operatorWallet.toLowerCase()) {
    return { ok: false, reason: "invalid_signature", detail: "signature wallet mismatch" };
  }
  // The signature must come from the key the REGISTRY knows, not merely from the
  // key the request claims. Otherwise anyone could sign as any agent.
  if (
    args.registeredOperatorWallet.toLowerCase() !== envelope.operatorWallet.toLowerCase()
  ) {
    return { ok: false, reason: "forbidden", detail: "not the registered operator wallet" };
  }

  return { ok: true };
}

// ── Idempotency ───────────────────────────────────────────────────────────────

export interface IdempotencyRecord {
  key: string;
  /** Hash of the body the key was first used with. */
  bodyHash: string;
  /** Response to replay, when the original completed. */
  response?: { status: number; body: unknown };
  createdAt: number;
}

export type IdempotencyOutcome =
  /** First time: proceed and record the result. */
  | { kind: "proceed" }
  /** Same key, same body, already completed: replay the stored response. */
  | { kind: "replay"; response: { status: number; body: unknown } }
  /** Same key, same body, still running: the caller must wait, not duplicate. */
  | { kind: "in_flight" }
  /** Same key, DIFFERENT body: refuse rather than guess which one was meant. */
  | { kind: "conflict" };

/**
 * Decide what to do with an idempotency key.
 *
 * A key reused with a different body is a caller bug, and guessing which request
 * was intended could double-spend. It is refused.
 */
export function checkIdempotency(
  key: string | undefined,
  currentBodyHash: string,
  store: ReadonlyMap<string, IdempotencyRecord>,
): IdempotencyOutcome {
  if (!key) return { kind: "proceed" };
  const existing = store.get(key);
  if (!existing) return { kind: "proceed" };
  if (existing.bodyHash !== currentBodyHash) return { kind: "conflict" };
  if (existing.response) return { kind: "replay", response: existing.response };
  return { kind: "in_flight" };
}
