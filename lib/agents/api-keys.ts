/**
 * API keys for the agent API.
 *
 * A key is a bearer credential, so the blast radius has to be bounded by something
 * other than the credential itself: what a key can spend is capped by the
 * owner-signed spend permission, and the owner can revoke either side
 * independently. A leaked key costs at most the remaining allowance.
 *
 * Only the SHA-256 of the secret is stored. The secret is returned once, at issue,
 * and cannot be recovered afterwards — a database dump therefore does not hand over
 * working credentials.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Distinguishes a real key from a sandbox one at a glance in logs and support. */
export type ApiKeyEnvironment = "live" | "test";

export const API_KEY_PREFIX_LENGTH = 14;

function environmentTag(env: ApiKeyEnvironment): string {
  return env === "live" ? "mk_live_" : "mk_test_";
}

/**
 * 32 bytes of randomness, base64url so the whole key is copy-pasteable into a
 * shell and an Authorization header without escaping.
 */
export function generateApiKey(env: ApiKeyEnvironment = "live"): string {
  return `${environmentTag(env)}${randomBytes(32).toString("base64url")}`;
}

export function isApiKeyFormat(value: string): boolean {
  return /^mk_(live|test)_[A-Za-z0-9_-]{20,}$/.test(value.trim());
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key.trim(), "utf8").digest("hex");
}

/** Shown in listings so an owner can tell two keys apart without seeing either. */
export function apiKeyPrefix(key: string): string {
  return key.trim().slice(0, API_KEY_PREFIX_LENGTH);
}

/**
 * Compare two hashes without leaking where they differ. Both are hex digests of
 * fixed width, so a length mismatch means malformed input rather than a near miss.
 */
export function hashesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Pull the key out of an Authorization header.
 *
 * Accepts a bare key too: agents are written by third parties against curl
 * examples, and rejecting `Authorization: mk_live_…` teaches nothing useful.
 */
export function parseApiKeyHeader(header: string | null | undefined): string | null {
  if (!header) return null;
  const raw = header.trim();
  const value = /^bearer\s+/i.test(raw) ? raw.replace(/^bearer\s+/i, "").trim() : raw;
  return isApiKeyFormat(value) ? value : null;
}

export interface AgentApiKeyRecord {
  keyId: string;
  agentId: string;
  keyHash: string;
  keyPrefix: string;
  label: string;
  createdAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
  revokedReason?: string;
}

export type ApiKeyRejection = "not_found" | "revoked";

/** Pure decision so the accept/reject rule is testable without a database. */
export function checkApiKeyRecord(
  record: AgentApiKeyRecord | null,
): { ok: true; record: AgentApiKeyRecord } | { ok: false; reason: ApiKeyRejection } {
  if (!record) return { ok: false, reason: "not_found" };
  if (record.revokedAt) return { ok: false, reason: "revoked" };
  return { ok: true, record };
}
