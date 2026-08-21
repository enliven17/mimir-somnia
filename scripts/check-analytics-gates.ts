import { readFile } from "node:fs/promises";
import { evaluateAnalyticsQuality, type ExportedAnalyticsEvent } from "../lib/analytics/quality";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: npm run verify:analytics -- <posthog-events.json>");
  process.exit(2);
}

const parsed = JSON.parse(await readFile(inputPath, "utf8")) as unknown;
const events = Array.isArray(parsed)
  ? parsed
  : (parsed && typeof parsed === "object" && Array.isArray((parsed as { results?: unknown }).results))
    ? (parsed as { results: unknown[] }).results
    : null;
if (!events) throw new Error("Expected a JSON array or an object with a results array");

const report = evaluateAnalyticsQuality(events as ExportedAnalyticsEvent[], {
  minimumEvents: Number(process.env.ANALYTICS_GATE_MIN_EVENTS ?? 100),
  completenessTarget: Number(process.env.ANALYTICS_GATE_COMPLETENESS ?? 0.99),
});
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exit(1);
