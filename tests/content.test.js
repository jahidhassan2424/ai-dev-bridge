const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const context = {};
vm.runInNewContext(fs.readFileSync("chrome-extension/capture-logic.js", "utf8"), context);
const { isCompletionSafe } = context.AiDevBridgeCaptureLogic;

function state(overrides = {}) {
  return {
    latest: true,
    connected: true,
    generationActive: false,
    now: 2_000,
    quietPeriodMs: 1_000,
    ...overrides,
  };
}

test("accepts a short response after a quiet period without a stop control", () => {
  assert.equal(
    isCompletionSafe({ text: "OK", lastChangedAt: 900, stableChecks: 1, manuallyStopped: false }, state()),
    true,
  );
});

test("rejects streaming, active, stale, and manually stopped responses", () => {
  const candidate = { text: "partial", lastChangedAt: 0, stableChecks: 1, manuallyStopped: false };
  assert.equal(isCompletionSafe(candidate, state({ generationActive: true })), false);
  assert.equal(isCompletionSafe(candidate, state({ now: 500 })), false);
  assert.equal(isCompletionSafe({ ...candidate, manuallyStopped: true }, state()), false);
  assert.equal(isCompletionSafe({ ...candidate, text: "" }, state()), false);
});

test("rejects detached or non-latest assistant messages", () => {
  const candidate = { text: "complete", lastChangedAt: 0, stableChecks: 1, manuallyStopped: false };
  assert.equal(isCompletionSafe(candidate, state({ connected: false })), false);
  assert.equal(isCompletionSafe(candidate, state({ latest: false })), false);
});
