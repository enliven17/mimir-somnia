/**
 * Which markets a council cycle spends itself on.
 *
 * The venue mints markets continuously, and the newest ones expire soonest — so
 * ordering purely by expiry walked the council straight onto books that had
 * never traded. Every persona then abstained for the same reason in different
 * words: no crowd to fade, no history to fit, confidence under threshold. A
 * whole cycle, twenty wallets, nothing bought.
 *
 * The ordering below is the fix, lifted out so it can be checked without a
 * venue: a market that has traded comes first, and among equals the one closest
 * to being graded.
 */
import assert from "node:assert/strict";
import test from "node:test";

interface Candidate {
  id: string;
  tradeCount: number;
  expiry: number;
}

/** Mirrors the comparator in pollMarkets. */
function order(markets: Candidate[]): Candidate[] {
  return [...markets].sort((a, b) => {
    const priced = Number(b.tradeCount > 0) - Number(a.tradeCount > 0);
    return priced !== 0 ? priced : a.expiry - b.expiry;
  });
}

test("a traded market outranks an untraded one that expires sooner", () => {
  const picked = order([
    { id: "fresh-empty", tradeCount: 0, expiry: 100 },
    { id: "older-traded", tradeCount: 12, expiry: 900 },
  ]);
  assert.equal(picked[0]?.id, "older-traded");
});

test("among traded markets, the soonest to settle still leads", () => {
  const picked = order([
    { id: "later", tradeCount: 5, expiry: 900 },
    { id: "sooner", tradeCount: 1, expiry: 200 },
  ]);
  assert.deepEqual(picked.map((m) => m.id), ["sooner", "later"]);
});

test("untraded markets are not dropped, only demoted", () => {
  // They are still the right choice when nothing has traded at all, and a venue
  // that has just rolled its whole series is exactly that case.
  const picked = order([
    { id: "empty-late", tradeCount: 0, expiry: 900 },
    { id: "empty-soon", tradeCount: 0, expiry: 200 },
  ]);
  assert.deepEqual(picked.map((m) => m.id), ["empty-soon", "empty-late"]);
});

test("a full slate orders traded-then-soonest, untraded-then-soonest", () => {
  const picked = order([
    { id: "e2", tradeCount: 0, expiry: 400 },
    { id: "t2", tradeCount: 3, expiry: 800 },
    { id: "e1", tradeCount: 0, expiry: 100 },
    { id: "t1", tradeCount: 9, expiry: 600 },
  ]);
  assert.deepEqual(picked.map((m) => m.id), ["t1", "t2", "e1", "e2"]);
});
