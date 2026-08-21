import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../lib/db.ts", import.meta.url), "utf8");

test("projection and basket backlog tables are present", () => {
  for (const table of ["market_series", "profile_stats", "conviction_scores", "basket_definitions", "basket_positions", "basket_nav_snapshots"]) {
    assert.match(source, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`));
  }
});

test("new tables carry stable ids, schema versions, timestamps and unique replay guards", () => {
  for (const table of ["market_series", "profile_stats", "conviction_scores", "basket_definitions", "basket_positions", "basket_nav_snapshots"]) {
    const start = source.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
    const body = start < 0 ? "" : source.slice(start, source.indexOf("\n  )`", start));
    assert.match(body, /\w+_id TEXT PRIMARY KEY/);
    assert.match(body, /schema_version SMALLINT NOT NULL/);
    assert.match(body, /created_at BIGINT NOT NULL/);
    assert.match(body, /updated_at BIGINT NOT NULL/);
    assert.match(body, /\bUNIQUE(?:\(|\b)/);
  }
  assert.match(source, /CREATE TABLE IF NOT EXISTS schema_migrations/);
});
