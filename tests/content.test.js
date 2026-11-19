const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const context = {};
vm.runInNewContext(fs.readFileSync("chrome-extension/capture-logic.js", "utf8"), context);
const { extractAssistantText, getResponseKey, isCompletionSafe, completionDelay, normalizeComposerText, hasComposerDraft, isComposerReady } = context.AiDevBridgeCaptureLogic;

test("extracts verified assistant markup without toolbar controls", () => {
  const markdownNode = {
    innerText: "Readable answer Copy",
    textContent: "Readable answer Copy",
    cloneNode() {
      return {
        innerText: "Readable answer",
        textContent: "Readable answer",
        querySelectorAll(selector) {
          assert.match(selector, /button/);
          return [];
        },
      };
    },
  };
  const message = {
    querySelectorAll(selector) {
      assert.equal(selector, '[data-markdown-text-style="assistant-message"]');
      return [markdownNode];
    },
  };

  assert.equal(extractAssistantText(message), "Readable answer");
});

test("extracts response content from the sibling response body, not the assistant heading", () => {
  const heading = { textContent: "Assistant" };
  const markdownNode = {
    cloneNode() {
      return {
        innerText: "Answer from dil response",
        textContent: "Answer from dil response",
        querySelectorAll() {
          return [];
        },
      };
    },
  };
  const responseBody = { querySelectorAll() { return [markdownNode]; } };
  const wrapper = {
    querySelectorAll(selector) {
      if (selector === '[data-markdown-text-style="assistant-message"]') return [markdownNode];
      if (selector === "[data-response-body]") return [responseBody];
      return [];
    },
    children: [heading, responseBody],
  };

  assert.equal(extractAssistantText(wrapper), "Answer from dil response");
  assert.notEqual(extractAssistantText(wrapper), heading.textContent);
});

test("deduplication key includes both response ID and extracted content", () => {
  assert.equal(getResponseKey("response-1", "same text"), "response-1::same text");
  assert.notEqual(getResponseKey("response-1", "same text"), getResponseKey("response-2", "same text"));
  assert.notEqual(getResponseKey("response-1", "same text"), getResponseKey("response-1", "updated text"));
});

test("content script targets assistant wrappers rather than role headings", () => {
  const contentScript = fs.readFileSync("chrome-extension/content.js", "utf8");
  assert.match(contentScript, /data-chatgpt-search-unit-key\$=\":assistant\"/);
  assert.doesNotMatch(contentScript, /\[conversation-role=\"assistant\"\]/);
});

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

test("rearms a completed candidate after generation becomes idle without polling", () => {
  const candidate = { text: "complete", lastChangedAt: 900, stableChecks: 1, manuallyStopped: false };
  assert.equal(completionDelay(candidate, { generationActive: true, now: 2_000, quietPeriodMs: 1_000 }), null);
  assert.equal(completionDelay(candidate, { generationActive: false, now: 2_000, quietPeriodMs: 1_000 }), 0);
  assert.equal(completionDelay({ ...candidate, lastChangedAt: 1_500 }, { generationActive: false, now: 2_000, quietPeriodMs: 1_000 }), 500);
});

test("composer readiness accepts ChatGPT's disabled empty Send control but rejects it when enabled Send is required", () => {
  const ready = { generationActive: false, composerVisible: true, composerEmpty: true, sendVisible: true, sendDisabled: false, securityPrompt: false };
  assert.equal(isComposerReady(ready), true);
  assert.equal(isComposerReady({ ...ready, generationActive: true }), false);
  assert.equal(isComposerReady({ ...ready, composerEmpty: false }), false);
  assert.equal(isComposerReady({ ...ready, sendDisabled: true }), true);
  assert.equal(isComposerReady({ ...ready, sendDisabled: true, requireEnabledSend: true }), false);
  assert.equal(isComposerReady({ ...ready, securityPrompt: true }), false);
});

test("composer draft normalization ignores empty editor scaffolding but preserves actual text", () => {
  assert.equal(normalizeComposerText(" \n\u200B\uFEFF "), "");
  assert.equal(hasComposerDraft(" \n\u200B\uFEFF "), false);
  assert.equal(hasComposerDraft("Ask ChatGPT"), true);
  assert.equal(hasComposerDraft("real user draft"), true);
});

test("content script includes safe Codex result delivery guards", () => {
  const contentScript = fs.readFileSync("chrome-extension/content.js", "utf8");
  assert.match(contentScript, /beginCodexDelivery/);
  assert.match(contentScript, /finishCodexDelivery/);
  assert.match(contentScript, /codexReturnInFlight/);
  assert.match(contentScript, /isGenerationInProgress/);
});

test("Codex delivery confirms a new matching user message, not an empty composer", () => {
  const contentScript = fs.readFileSync("chrome-extension/content.js", "utf8");
  assert.match(contentScript, /data-chatgpt-search-unit-key\$=":user"/);
  assert.match(contentScript, /data-message-author-role="user"/);
  assert.match(contentScript, /waitForMatchingUserMessage/);
  assert.match(contentScript, /userMessageBaseline/);
  assert.match(contentScript, /!baseline\.elements\.has\(element\)/);
  assert.doesNotMatch(contentScript, /const cleared = await waitForComposerClear/);
});

test("Codex delivery emits metadata-only lifecycle diagnostics", () => {
  const contentScript = fs.readFileSync("chrome-extension/content.js", "utf8");
  for (const stage of ["watch-started", "eligibility", "availability", "composer-detection", "composer-revalidation", "insertion", "send-attempt", "confirmation", "attempted-unconfirmed", "not-attempted"]) {
    assert.match(contentScript, new RegExp(`codexDeliveryDiagnostic\\(\\"${stage}\\"`));
  }
  assert.match(contentScript, /console\.info\("\[AI Dev Bridge\] Codex delivery"/);
  assert.doesNotMatch(contentScript, /console\.log\([^\n]*result\.response/);
});

test("Codex delivery checks only a selected active composer and never uses page text as a draft fallback", () => {
  const contentScript = fs.readFileSync("chrome-extension/content.js", "utf8");
  assert.match(contentScript, /element\.isConnected && isComposerElement\(element\) && !isAriaHidden\(element\) && isVisible\(element\)/);
  assert.match(contentScript, /function composerDraftState/);
  assert.match(contentScript, /composer\.cloneNode\(true\)/);
  assert.match(contentScript, /composer-revalidation/);
  assert.doesNotMatch(contentScript, /composerValue\(composer \|\| document\.body\)/);
  assert.doesNotMatch(contentScript, /composerValue\(document\.body\)/);
});

test("Codex delivery waits for React to enable Send and records attempted state without trusting composer clearing", () => {
  const contentScript = fs.readFileSync("chrome-extension/content.js", "utf8");
  assert.match(contentScript, /document\.execCommand\?\.\("insertText"/);
  assert.match(contentScript, /emitComposerInput/);
  assert.match(contentScript, /waitForEnabledSendButton/);
  assert.match(contentScript, /attempted: clicked/);
  assert.doesNotMatch(contentScript, /waitForComposerClear\(composer\)/);
});

test("an uncertain report stays blocked without stopping discovery of newer results", () => {
  const contentScript = fs.readFileSync("chrome-extension/content.js", "utf8");
  assert.match(contentScript, /available\.status === "uncertain" \|\| available\.status === "error"/);
  assert.doesNotMatch(contentScript, /available\.status === "uncertain"\) stopCodexResultWatch/);
});

test("live capture preserves candidates across wrapper rerenders and SPA navigation", () => {
  const contentScript = fs.readFileSync("chrome-extension/content.js", "utf8");
  assert.match(contentScript, /candidateKeys/);
  assert.match(contentScript, /wrapper-rerendered/);
  assert.match(contentScript, /candidateKeys\.set\(messageKey, message\)/);
  assert.match(contentScript, /resetForConversation/);
  assert.match(contentScript, /observedConversationPath/);
  assert.match(contentScript, /latestKey === getMessageKey\(message\)/);
  assert.match(contentScript, /pushState/);
  assert.match(contentScript, /replaceState/);
});

test("live capture keeps conversation identity in deduplication keys", () => {
  const contentScript = fs.readFileSync("chrome-extension/content.js", "utf8");
  assert.match(contentScript, /getResponseKey\(`\$\{normalizeConversationUrl\(location\.href\)\?\.path/);
  assert.match(contentScript, /MutationObserver\(\(\) => requestReconciliation\("mutation"\)\)/);
  assert.match(contentScript, /generationWasActive/);
  assert.match(contentScript, /completionDelay\(candidate/);
  assert.doesNotMatch(contentScript, /setInterval\([^\n]*inspectForResponses/);
});

test("live capture reports metadata-only lifecycle diagnostics and fails safely after extension invalidation", () => {
  const contentScript = fs.readFileSync("chrome-extension/content.js", "utf8");
  for (const stage of ["candidate-detected", "completion-accepted", "completion-rejected", "storage-result", "forwarding-started", "forwarding-result", "context-invalidated"]) {
    assert.match(contentScript, new RegExp(`captureDiagnostic\\("${stage}"`));
  }
  assert.match(contentScript, /extensionContextIsAvailable/);
  assert.match(contentScript, /observer-stopped-awaiting-content-script-reinjection/);
  assert.doesNotMatch(contentScript, /captureDiagnostic\([^\n]*\{[^\n]*\btext\s*:/);
});

test("reload recovery baselines existing messages instead of replaying history", () => {
  const contentScript = fs.readFileSync("chrome-extension/content.js", "utf8");
  assert.match(contentScript, /function startCapture\(\) \{\s+stopCapture\(\);\s+rememberCurrentMessages\(\);/);
  assert.match(contentScript, /baselineMessageKeys\.has\(messageKey\) && baselineMessageTexts\.get\(messageKey\) === text/);
  assert.match(contentScript, /pageshow/);
});
