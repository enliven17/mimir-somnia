import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAnalyticsQuality, type ExportedAnalyticsEvent } from "../../lib/analytics/quality";

function row(event: string, complete = true): ExportedAnalyticsEvent {
  return { event, properties: complete
    ? { event_version: 1, chain_id: 84532, settlement_mode: "pool", is_internal: false }
    : { event_version: 1, chain_id: 84532, is_internal: false } };
}

test("the KPI gate accepts measurable funnels at 99 percent completeness", () => {
  const events = [
    ...Array.from({ length: 40 }, () => row("create_started")),
    ...Array.from({ length: 20 }, () => row("create_confirmed")),
    ...Array.from({ length: 30 }, () => row("market_viewed")),
    ...Array.from({ length: 10 }, () => row("stake_confirmed")),
  ];
  const report = evaluateAnalyticsQuality(events);
  assert.equal(report.passed, true);
  assert.equal(report.completeness, 1);
  assert.equal(report.createConversion, 0.5);
  assert.equal(report.stakeConversion, 1 / 3);
});

test("the KPI gate rejects sparse, incomplete or internally inconsistent exports", () => {
  const events = [row("create_started", false), row("create_confirmed"), row("create_confirmed"), row("market_viewed")];
  const report = evaluateAnalyticsQuality(events, { minimumEvents: 1 });
  assert.equal(report.passed, false);
  assert.ok(report.failures.some((failure) => failure.includes("completeness")));
  assert.ok(report.failures.some((failure) => failure.includes("confirmations exceed starts")));
  assert.ok(report.failures.some((failure) => failure.includes("stake funnel")));
});

test("internal traffic and unrelated PostHog events cannot satisfy the gate", () => {
  const internal = row("market_viewed");
  internal.properties = { ...internal.properties, is_internal: true };
  const report = evaluateAnalyticsQuality([internal, row("$pageview")], { minimumEvents: 1 });
  assert.equal(report.productEvents, 0);
  assert.equal(report.passed, false);
});
