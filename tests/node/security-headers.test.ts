import assert from "node:assert/strict";
import test from "node:test";
import nextConfig from "../../next.config.js";

test("all routes receive baseline browser security headers", async () => {
  assert.ok(nextConfig.headers);
  const rules = await nextConfig.headers!();
  const headers = new Map(rules[0].headers.map((entry: { key: string; value: string }) => [entry.key, entry.value]));
  for (const required of ["Content-Security-Policy", "Strict-Transport-Security", "X-Frame-Options", "X-Content-Type-Options", "Referrer-Policy", "Permissions-Policy"]) assert.ok(headers.has(required), required);
  assert.match(headers.get("Content-Security-Policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(headers.get("X-Frame-Options"), "DENY");
});
