import assert from "node:assert/strict";
import test from "node:test";

/**
 * pickGeminiModel reads GEMINI_MODELS at call time, so each case sets it first.
 * Imported lazily for the same reason: DEFAULT_GEMINI_MODEL is captured at import.
 */
async function pick(seed: string, models: string): Promise<string> {
  process.env.GEMINI_MODELS = models;
  const { pickGeminiModel } = await import("../../lib/llm");
  return pickGeminiModel(seed);
}

const MIXED = "gemini-3.1-flash-lite,gemma-4-31b-it,gemini-3.5-flash,gemma-4-26b-a4b-it";

test("no agent is ever assigned a Gemma model", async () => {
  // Gemma reasons in prose before the JSON, which silently starves the strict-JSON
  // budget every caller uses: the council abstains and the market-creator ships no
  // markets. A hashed assignment must not be able to retire an agent this way.
  for (const seed of ["market-creator", "oracle", "council", "socrates", "ada", "taleb"]) {
    const model = await pick(seed, MIXED);
    assert.ok(!model.startsWith("gemma"), `${seed} was assigned ${model}`);
  }
});

test("assignment is stable and spreads across the usable pool", async () => {
  assert.equal(await pick("oracle", MIXED), await pick("oracle", MIXED));
  const picks = new Set(
    await Promise.all(["a", "b", "c", "d", "e", "f"].map((s) => pick(s, MIXED))),
  );
  assert.ok(picks.size > 1, "every seed collapsed onto one model");
});

test("a Gemma-only pool falls back instead of returning undefined", async () => {
  const model = await pick("oracle", "gemma-4-31b-it,gemma-4-26b-a4b-it");
  assert.ok(model && !model.startsWith("gemma"), `got ${String(model)}`);
});
