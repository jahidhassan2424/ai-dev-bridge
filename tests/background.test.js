const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

function runBackground(fetchResult, selectedUrl = "https://chatgpt.com/c/test", incomingUrl = "https://chatgpt.com/c/test") {
  let listener;
  const context = {
    AbortController,
    URL,
    clearTimeout,
    console,
    fetch: async () => fetchResult,
    setTimeout,
    chrome: {
      storage: { local: { get: async () => ({ autoForwardEnabled: true, selectedConversationUrl: selectedUrl }) } },
      runtime: {
        id: "extension-id",
        onMessage: { addListener(callback) { listener = callback; } },
      },
    },
  };
  vm.runInNewContext(fs.readFileSync("chrome-extension/background.js", "utf8"), context);
  return new Promise((resolve) => {
    listener(
      { type: "forwardCapture", capture: { id: "id", text: "data", conversationUrl: incomingUrl } },
      { id: "extension-id" },
      resolve,
    );
  });
}

test("background reports success only for a valid bridge acknowledgment", async () => {
  const result = await runBackground({
    ok: true,
    status: 200,
    json: async () => ({ success: true, duplicate: false }),
  });
  assert.equal(result.success, true);
  assert.equal(result.duplicate, false);
});

test("background reports malformed acknowledgments as failures", async () => {
  const result = await runBackground({
    ok: true,
    status: 200,
    json: async () => ({ success: true }),
  });
  assert.equal(result.success, false);
  assert.equal(result.error, "Bridge returned 200");
});

test("background ignores a capture from another conversation tab", async () => {
  const result = await runBackground({ ok: true, status: 200, json: async () => ({ success: true, duplicate: false }) }, "https://chatgpt.com/c/selected", "https://chatgpt.com/g/g-custom/c/other");
  assert.equal(result.success, true);
  assert.equal(result.ignored, true);
});

test("terminal marker invokes the authenticated Stop command and disables both automatic paths", async () => {
  let request;
  const capture = { id: "stop-response", text: "Complete\nAI_BRIDGE_STOP", timestamp: "2026-11-19T12:00:00.000Z", conversationUrl: "https://chatgpt.com/c/test" };
  const { result, storage } = await runDeliveryMessage(
    { type: "stopAutomationForTerminalSignal", capture },
    { codexPairingToken: "paired-token", selectedConversationUrl: capture.conversationUrl, autoForwardEnabled: true, autoSubmitCodexResultsEnabled: true },
    async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return bridgeResponse({ success: true, state: { stopped: true, stoppedReason: "task-completed", stoppedAt: "2026-11-19T12:00:01.000Z" } });
    },
    capture.conversationUrl,
    true,
  );
  assert.equal(result.success, true);
  assert.equal(request.url.endsWith("/api/codex/control"), true);
  assert.equal(request.body.command, "stop");
  assert.equal(request.body.reason, "task-completed");
  assert.equal(request.options.headers.Authorization, "Bearer paired-token");
  assert.equal(storage.autoForwardEnabled, false);
  assert.equal(storage.autoSubmitCodexResultsEnabled, false);
});

function runDeliveryMessage(message, initialState, fetchImpl, selectedUrl = "https://chatgpt.com/c/test", includeStorage = false) {
  let listener;
  const storage = { ...initialState };
  const context = {
    URL,
    console,
    chrome: {
      storage: {
        local: {
          get: async (keys) => {
            if (!Array.isArray(keys)) return { ...storage };
            return Object.fromEntries(keys.filter((key) => Object.prototype.hasOwnProperty.call(storage, key)).map((key) => [key, storage[key]]));
          },
          set: async (values) => Object.assign(storage, values),
          remove: async (keys) => { for (const key of (Array.isArray(keys) ? keys : [keys])) delete storage[key]; },
        },
      },
      runtime: { id: "extension-id", onMessage: { addListener(callback) { listener = callback; } } },
    },
    fetch: fetchImpl,
  };
  vm.runInNewContext(fs.readFileSync("chrome-extension/background.js", "utf8"), context);
  return new Promise((resolve) => listener({ ...message, conversationUrl: message.conversationUrl || selectedUrl }, { id: "extension-id" }, (result) => resolve(includeStorage ? { result, storage } : result)));
}

function runConcurrentDeliveryMessages(messages, initialState, fetchImpl, selectedUrl = "https://chatgpt.com/c/test") {
  let listener;
  const storage = { ...initialState };
  const context = {
    URL,
    console,
    chrome: {
      storage: {
        local: {
          get: async (keys) => Object.fromEntries(keys.filter((key) => Object.prototype.hasOwnProperty.call(storage, key)).map((key) => [key, storage[key]])),
          set: async (values) => { await new Promise((resolve) => setTimeout(resolve, 5)); Object.assign(storage, values); },
        },
      },
      runtime: { id: "extension-id", onMessage: { addListener(callback) { listener = callback; } } },
    },
    fetch: fetchImpl,
    setTimeout,
  };
  vm.runInNewContext(fs.readFileSync("chrome-extension/background.js", "utf8"), context);
  return Promise.all(messages.map((message) => new Promise((resolve) => listener({ ...message, conversationUrl: message.conversationUrl || selectedUrl }, { id: "extension-id" }, resolve))));
}

function createDeliverySession(initialState, fetchImpl, selectedUrl = "https://chatgpt.com/c/test") {
  let listener;
  const storage = { ...initialState };
  const context = {
    URL, console, setTimeout, clearTimeout,
    chrome: {
      storage: { local: {
        get: async (keys) => Object.fromEntries(keys.filter((key) => Object.prototype.hasOwnProperty.call(storage, key)).map((key) => [key, storage[key]])),
        set: async (values) => Object.assign(storage, values),
        remove: async (keys) => { for (const key of (Array.isArray(keys) ? keys : [keys])) delete storage[key]; },
      } },
      runtime: { id: "extension-id", onMessage: { addListener(callback) { listener = callback; } } },
    },
    fetch: fetchImpl,
  };
  vm.runInNewContext(fs.readFileSync("chrome-extension/background.js", "utf8"), context);
  return { storage, invoke: (message) => new Promise((resolve) => listener({ ...message, conversationUrl: message.conversationUrl || selectedUrl }, { id: "extension-id" }, resolve)) };
}

function bridgeResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const completedResult = {
  submissionId: "submission-1",
  threadId: "thread-1",
  response: "Codex completed the task.",
  status: "completed",
  timestamp: "2026-11-17T12:00:00.000Z",
  sourceConversationUrl: "https://chatgpt.com/c/test",
};

function deliveryFetch(url) {
  if (url.includes("/api/codex/control")) return Promise.resolve(bridgeResponse({ success: true, state: { enabled: true, paused: false, conversationUrl: "https://chatgpt.com/c/test" } }));
  if (url.includes("/api/codex/delivery-status")) return Promise.resolve(bridgeResponse({ success: true, status: "submitted" }));
  return Promise.resolve(bridgeResponse({ result: completedResult }));
}

test("Codex result delivery requires exact matching automation conversation", async () => {
  const result = await runDeliveryMessage({ type: "getCodexResultForConversation", conversationUrl: "https://chatgpt.com/g/custom/c/other" }, {
    autoSubmitCodexResultsEnabled: true,
    codexPairingToken: "paired-token",
    selectedConversationUrl: "https://chatgpt.com/c/test",
  }, deliveryFetch);
  assert.equal(result.status, "disabled");
});

test("Codex result delivery is deduplicated and persisted after completion", async () => {
  const state = { autoSubmitCodexResultsEnabled: true, codexPairingToken: "paired-token", selectedConversationUrl: "https://chatgpt.com/c/test" };
  const begun = await runDeliveryMessage({ type: "beginCodexDelivery", submissionId: "submission-1" }, state, deliveryFetch);
  assert.equal(begun.success, true);
  const duplicate = await runDeliveryMessage({ type: "getCodexResultForConversation" }, { ...state, codexDeliveryState: { status: "submitting", submissionId: "submission-1", conversationPath: "/c/test" } }, deliveryFetch);
  assert.equal(duplicate.status, "uncertain");
  const finished = await runDeliveryMessage({ type: "finishCodexDelivery", submissionId: "submission-1", status: "submitted", messageKey: "message-1", evidence: "observed" }, { ...state, codexDeliveryState: { status: "submitting", submissionId: "submission-1", conversationPath: "/c/test", reportFingerprint: "25:8ed8ea07" } }, deliveryFetch);
  assert.equal(finished.success, true);
  const already = await runDeliveryMessage({ type: "getCodexResultForConversation" }, { ...state, codexDeliveryState: { status: "submitted", submissionId: "submission-1", conversationPath: "/c/test" } }, deliveryFetch);
  assert.equal(already.status, "submitted");
});

test("restarted in-progress delivery becomes uncertain instead of replaying", async () => {
  const result = await runDeliveryMessage({ type: "getCodexResultForConversation" }, {
    autoSubmitCodexResultsEnabled: true,
    codexPairingToken: "paired-token",
    selectedConversationUrl: "https://chatgpt.com/c/test",
    codexDeliveryState: { status: "submitting", submissionId: "submission-1", conversationPath: "/c/test" },
  }, deliveryFetch);
  assert.equal(result.status, "uncertain");
  assert.match(result.error, /manual review/i);
});

test("an older uncertain delivery does not block a newer completed submission", async () => {
  const newerResult = { ...completedResult, submissionId: "submission-2", timestamp: "2026-11-18T12:00:00.000Z" };
  const newerFetch = (url) => url.includes("/api/codex/control")
    ? Promise.resolve(bridgeResponse({ success: true, state: { enabled: true, paused: false, conversationUrl: "https://chatgpt.com/c/test" } }))
    : Promise.resolve(bridgeResponse({ result: newerResult }));
  const result = await runDeliveryMessage({ type: "getCodexResultForConversation" }, {
    autoSubmitCodexResultsEnabled: true,
    codexPairingToken: "paired-token",
    selectedConversationUrl: "https://chatgpt.com/c/test",
    codexDeliveryState: { status: "uncertain", submissionId: "submission-1", conversationPath: "/c/test", attempted: false },
  }, newerFetch);
  assert.equal(result.status, "ready");
  assert.equal(result.result.submissionId, "submission-2");
});

test("the same uncertain submission remains blocked and is never replayed", async () => {
  const result = await runDeliveryMessage({ type: "getCodexResultForConversation" }, {
    autoSubmitCodexResultsEnabled: true,
    codexPairingToken: "paired-token",
    selectedConversationUrl: "https://chatgpt.com/c/test",
    codexDeliveryStates: {
      "%2Fc%2Ftest::submission-1": { status: "uncertain", submissionId: "submission-1", conversationPath: "/c/test", attempted: true, stage: "acknowledgment" },
    },
  }, deliveryFetch);
  assert.equal(result.status, "uncertain");
  assert.equal(result.submissionId, "submission-1");
  assert.equal(result.attempted, true);
});

test("starting a newer delivery preserves the older uncertain state by submission", async () => {
  const newerResult = { ...completedResult, submissionId: "submission-2", timestamp: "2026-11-18T12:00:00.000Z" };
  const newerFetch = (url) => url.includes("/api/codex/control")
    ? Promise.resolve(bridgeResponse({ success: true, state: { enabled: true, paused: false, conversationUrl: "https://chatgpt.com/c/test" } }))
    : Promise.resolve(bridgeResponse({ result: newerResult }));
  const { result, storage } = await runDeliveryMessage({ type: "beginCodexDelivery", submissionId: "submission-2" }, {
    autoSubmitCodexResultsEnabled: true,
    codexPairingToken: "paired-token",
    selectedConversationUrl: "https://chatgpt.com/c/test",
    codexDeliveryState: { status: "uncertain", submissionId: "submission-1", conversationPath: "/c/test", attempted: false },
  }, newerFetch, undefined, true);
  assert.equal(result.success, true);
  assert.equal(storage.codexDeliveryStates["%2Fc%2Ftest::submission-1"].status, "uncertain");
  assert.equal(storage.codexDeliveryStates["%2Fc%2Ftest::submission-2"].status, "submitting");
});

test("concurrent begin requests claim a completed report only once", async () => {
  const state = { autoSubmitCodexResultsEnabled: true, codexPairingToken: "paired-token", selectedConversationUrl: "https://chatgpt.com/c/test" };
  const results = await runConcurrentDeliveryMessages([
    { type: "beginCodexDelivery", submissionId: "submission-1" },
    { type: "beginCodexDelivery", submissionId: "submission-1" },
  ], state, deliveryFetch);
  assert.equal(results.filter((result) => result.success === true).length, 1);
  assert.equal(results.filter((result) => result.status === "submitting").length, 1);
});

test("failed or cancelled Codex results are never offered for automatic submission", async () => {
  const fetchFailed = (url) => {
    if (url.includes("/api/codex/control")) return Promise.resolve(bridgeResponse({ success: true, state: { enabled: true, paused: false, conversationUrl: "https://chatgpt.com/c/test" } }));
    return Promise.resolve(bridgeResponse({ result: { ...completedResult, status: "failed" } }));
  };
  const result = await runDeliveryMessage({ type: "getCodexResultForConversation" }, {
    autoSubmitCodexResultsEnabled: true,
    codexPairingToken: "paired-token",
    selectedConversationUrl: "https://chatgpt.com/c/test",
  }, fetchFailed);
  assert.equal(result.status, "idle");
});

test("unsafe composer conditions can persist manual-review state", async () => {
  const state = { autoSubmitCodexResultsEnabled: true, codexPairingToken: "paired-token", selectedConversationUrl: "https://chatgpt.com/c/test" };
  const result = await runDeliveryMessage({ type: "markCodexDeliveryUncertain", submissionId: "submission-1", error: "composer changed" }, state, deliveryFetch);
  assert.equal(result.success, true);
});

test("delivery state distinguishes a pre-send block from an attempted but unconfirmed report", async () => {
  const state = { autoSubmitCodexResultsEnabled: true, codexPairingToken: "paired-token", selectedConversationUrl: "https://chatgpt.com/c/test", codexDeliveryState: { status: "submitting", submissionId: "submission-1", conversationPath: "/c/test" } };
  const preSend = await runDeliveryMessage({ type: "finishCodexDelivery", submissionId: "submission-1", status: "uncertain", attempted: false, stage: "pre-send", error: "composer unavailable" }, state, deliveryFetch, undefined, true);
  assert.equal(preSend.result.success, true);
  assert.equal(preSend.storage.codexDeliveryState.attempted, false);
  assert.equal(preSend.storage.codexDeliveryState.stage, "pre-send");

  const attempted = await runDeliveryMessage({ type: "finishCodexDelivery", submissionId: "submission-1", status: "uncertain", attempted: true, stage: "acknowledgment", error: "message not observed" }, state, deliveryFetch, undefined, true);
  assert.equal(attempted.result.success, true);
  assert.equal(attempted.storage.codexDeliveryState.attempted, true);
  assert.equal(attempted.storage.codexDeliveryState.stage, "acknowledgment");
});

test("explicit delivery recovery confirms only the same uncertain report without resending", async () => {
  const state = {
    autoSubmitCodexResultsEnabled: true,
    codexPairingToken: "paired-token",
    selectedConversationUrl: "https://chatgpt.com/c/test",
    codexDeliveryState: { status: "uncertain", submissionId: "submission-1", conversationPath: "/c/test", attempted: true, reportFingerprint: "25:8ed8ea07", baselineMessageKeys: ["existing-message"] },
  };
  const recoverFetch = (url) => {
    if (url.includes("/api/codex/control")) return Promise.resolve(bridgeResponse({ success: true, state: { enabled: true, paused: false, conversationUrl: "https://chatgpt.com/c/test" } }));
    if (url.includes("/api/codex/delivery-status")) return Promise.resolve(bridgeResponse({ success: true, status: "submitted" }));
    return Promise.resolve(bridgeResponse({ result: completedResult }));
  };
  // Use the implementation's deterministic fingerprint rather than report text in state.
  const session = createDeliverySession(state, recoverFetch);
  const begun = await session.invoke({ type: "beginCodexDeliveryRecovery", submissionId: "submission-1" });
  assert.equal(begun.success, true);
  assert.equal(session.storage.codexDeliveryState.status, "verifying");
  const resolved = await session.invoke({ type: "resolveCodexDeliveryRecovery", submissionId: "submission-1", reportFingerprint: begun.reportFingerprint, outcome: "confirmed", messageKey: "message-1" });
  assert.equal(resolved.success, true);
  assert.equal(session.storage.codexDeliveryState.status, "submitted");
  assert.equal(session.storage.codexDeliveryState.stage, "recovery-confirmed");
});

test("legacy uncertain delivery requires explicit confirmation and never auto-confirms", async () => {
  const state = {
    autoSubmitCodexResultsEnabled: true,
    codexPairingToken: "paired-token",
    selectedConversationUrl: "https://chatgpt.com/c/test",
    codexDeliveryState: { status: "uncertain", submissionId: "submission-1", conversationPath: "/c/test", attempted: true },
  };
  const session = createDeliverySession(state, deliveryFetch);
  const begun = await session.invoke({ type: "beginCodexDeliveryRecovery", submissionId: "submission-1" });
  assert.equal(begun.success, true);
  assert.equal(begun.requiresManualConfirmation, true);
  assert.equal(session.storage.codexDeliveryState.status, "verifying");
});

test("abandoning an uncertain delivery preserves the record and prevents automatic replay", async () => {
  const state = {
    autoSubmitCodexResultsEnabled: true,
    codexPairingToken: "paired-token",
    selectedConversationUrl: "https://chatgpt.com/c/test",
    codexDeliveryState: { status: "uncertain", submissionId: "submission-1", conversationPath: "/c/test", attempted: true },
    codexReturnInFlight: { conversationPath: "/c/test", submissionId: "submission-1" },
  };
  const fetchImpl = (url) => url.includes("/api/codex/delivery-status")
    ? Promise.resolve(bridgeResponse({ success: true, status: "abandoned" })) : deliveryFetch(url);
  const { result, storage } = await runDeliveryMessage({ type: "abandonCodexDelivery", submissionId: "submission-1" }, state, fetchImpl, undefined, true);
  assert.equal(result.success, true);
  assert.equal(storage.codexDeliveryState.status, "abandoned");
  assert.equal(storage.codexReturnInFlight, undefined);
  const availability = await runDeliveryMessage({ type: "getCodexResultForConversation" }, storage, fetchImpl);
  assert.equal(availability.status, "abandoned");
});
