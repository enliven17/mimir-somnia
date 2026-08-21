import assert from "node:assert/strict";
import test from "node:test";

import {
  FAILURE_WINDOW_MS,
  parseWindow,
  windowToFailureWindow,
} from "../../lib/ops/heartbeat";

const NOW = 1_800_000_000_000;

test("a stored window parses", () => {
  const parsed = parseWindow(JSON.stringify({ startedAtMs: NOW, attempts: 100, failures: 4 }));
  assert.deepEqual(parsed, { startedAtMs: NOW, attempts: 100, failures: 4 });
});

test("a corrupt window parses to null instead of throwing", () => {
  // One bad row must not take the health endpoint down with it.
  assert.equal(parseWindow("{oops"), null);
  assert.equal(parseWindow("null"), null);
  assert.equal(parseWindow(null), null);
  assert.equal(parseWindow('{"attempts":5}'), null);
  assert.equal(parseWindow('{"startedAtMs":1,"attempts":-1,"failures":0}'), null);
});

test("more failures than attempts is clamped, not graphed as 300%", () => {
  const parsed = parseWindow(JSON.stringify({ startedAtMs: NOW, attempts: 10, failures: 30 }));
  assert.equal(parsed!.failures, 10);
});

test("a fresh window is passed through", () => {
  const window = windowToFailureWindow({ startedAtMs: NOW, attempts: 50, failures: 5 }, NOW + 1_000);
  assert.deepEqual(window, { attempts: 50, failures: 5 });
});

test("an expired window reads as empty so old data cannot alarm", () => {
  const window = windowToFailureWindow(
    { startedAtMs: NOW, attempts: 50, failures: 50 },
    NOW + FAILURE_WINDOW_MS,
  );
  assert.deepEqual(window, { attempts: 0, failures: 0 });
});

test("a missing window reads as empty", () => {
  assert.deepEqual(windowToFailureWindow(null, NOW), { attempts: 0, failures: 0 });
});

test("the window rolls over hourly", () => {
  // Long enough that a ratio means something, short enough that one bad hour does
  // not poison the signal for a day.
  assert.equal(FAILURE_WINDOW_MS, 3_600_000);
});
