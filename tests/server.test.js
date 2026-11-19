const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createCaptureStore, createServer, resolveVscodeTokenFile, validateCapturePayload } = require("../dist/server.js");

const origin = "chrome-extension://flpkdgbjocacgdlnfhinaeicigegfklb";
const capture = {
  id: "response-1",
  text: "Untrusted captured text",
  timestamp: "2026-11-17T12:00:00.000Z",
  conversationUrl: "https://chatgpt.com/c/example",
};

test("server token paths resolve from the bridge project regardless of launch directory", () => {
  assert.match(resolveVscodeTokenFile(".local/ai-dev-bridge-vscode.token"), /ai-dev-bridge[\\/]\.local[\\/]ai-dev-bridge-vscode\.token$/);
  assert.equal(resolveVscodeTokenFile("C:\\tokens\\bridge.token"), "C:\\tokens\\bridge.token");
});

test("authenticated context import targets the selected workspace session", async () => {
  const tokenDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-dev-bridge-context-import-"));
  const calls = [];
  class ContextManager {
    async connect() { calls.push("connect"); }
    async importProjectContext() { calls.push("import"); return { status: "initialized", path: path.join(process.cwd(), ".ai-bridge", "PROJECT_CONTEXT.md"), threadId: "context-thread" }; }
    async runPrompt() { throw new Error("not used"); }
    cancelCurrentTurn() {}
  }
  const server = createServer(createCaptureStore(), "test-vscode-token", () => new ContextManager(), path.join(tokenDirectory, "chrome.token"), false, path.join(tokenDirectory, "submissions.json"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/vscode/codex/import-context`, {
      method: "POST",
      headers: { Authorization: "Bearer test-vscode-token", "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: process.cwd(), sandboxMode: "read-only" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, context: { status: "initialized", path: path.join(process.cwd(), ".ai-bridge", "PROJECT_CONTEXT.md"), threadId: "context-thread" } });
    assert.deepEqual(calls, ["connect", "import"]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(tokenDirectory, { recursive: true, force: true });
  }
});

test("validates capture shape and bounds the in-memory store", () => {
  assert.deepEqual(validateCapturePayload(capture), capture);
  assert.equal(validateCapturePayload({ ...capture, conversationUrl: "https://evil.example/" }), undefined);

  const store = createCaptureStore();
  assert.equal(store.add(capture), true);
  assert.equal(store.add(capture), false);
  for (let index = 2; index <= 51; index += 1) {
    assert.equal(store.add({ ...capture, id: `response-${index}` }), true);
  }
  assert.equal(store.latest().length, 50);
  assert.equal(store.latest().some((item) => item.id === "response-1"), false);
  assert.deepEqual(store.status(), {
    count: 50,
    latestId: "response-51",
    latestTimestamp: capture.timestamp,
  });

  assert.equal(store.latestCodexResult(), null);
  assert.equal(store.setCodexResult({
    submissionId: "submission-1",
    threadId: "thread-1",
    response: "completed result",
    status: "completed",
    timestamp: capture.timestamp,
    sourceConversationUrl: capture.conversationUrl,
  }), true);
  assert.equal(store.latestCodexResult().response, "completed result");
  assert.equal(store.setCodexResult({
    submissionId: "submission-large",
    threadId: "thread-1",
    response: "x".repeat(900_001),
    status: "completed",
    timestamp: capture.timestamp,
    sourceConversationUrl: capture.conversationUrl,
  }), false);
});

test("capture endpoints require the extension origin and acknowledge duplicates", async () => {
  const server = createServer(undefined, "test-vscode-token");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;

  try {
    const unauthenticated = await fetch(`${url}/api/vscode/captures`);
    assert.equal(unauthenticated.status, 401);

    const authenticated = await fetch(`${url}/api/vscode/captures`, {
      headers: { Authorization: "Bearer test-vscode-token" },
    });
    assert.deepEqual((await authenticated.json()).captures, []);
    const unauthorizedApprovals = await fetch(`${url}/api/vscode/codex/approvals`);
    assert.equal(unauthorizedApprovals.status, 401);
    const emptyApprovals = await fetch(`${url}/api/vscode/codex/approvals`, {
      headers: { Authorization: "Bearer test-vscode-token" },
    });
    assert.deepEqual(await emptyApprovals.json(), { success: true, approvals: [] });

    const emptyCodex = await fetch(`${url}/api/codex/latest`, { headers: { Origin: origin } });
    assert.equal(emptyCodex.status, 401);
    const unauthenticatedCodex = await fetch(`${url}/api/codex/latest`);
    assert.equal(unauthenticatedCodex.status, 401);
    const chromeStyleWithoutOrigin = await fetch(`${url}/api/codex/latest`, {
      headers: { "X-AI-Dev-Bridge-Extension": "flpkdgbjocacgdlnfhinaeicigegfklb" },
    });
    assert.equal(chromeStyleWithoutOrigin.status, 401);
    const wrongOriginWithMarker = await fetch(`${url}/api/codex/latest`, {
      headers: { Origin: "https://chatgpt.com", "X-AI-Dev-Bridge-Extension": "flpkdgbjocacgdlnfhinaeicigegfklb" },
    });
    assert.equal(wrongOriginWithMarker.status, 403);

    const forbidden = await fetch(`${url}/api/captures`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://chatgpt.com" },
      body: JSON.stringify(capture),
    });
    assert.equal(forbidden.status, 403);

    const first = await fetch(`${url}/api/captures`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(capture),
    });
    assert.deepEqual(await first.json(), { success: true, duplicate: false, automation: { decision: "skipped", reason: "disabled" } });

    const duplicate = await fetch(`${url}/api/captures`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(capture),
    });
    assert.deepEqual(await duplicate.json(), { success: true, duplicate: true, automation: { decision: "skipped", reason: "duplicate" } });

    const invalid = await fetch(`${url}/api/captures`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ ...capture, id: "" }),
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { success: false, error: "Invalid capture payload" });

    const latest = await fetch(`${url}/api/captures/latest`, { headers: { Origin: origin } });
    assert.deepEqual((await latest.json()).captures, [capture]);

    const status = await fetch(`${url}/api/captures/status`, { headers: { Origin: origin } });
    assert.deepEqual(await status.json(), {
      count: 1,
      latestId: capture.id,
      latestTimestamp: capture.timestamp,
    });

    const forbiddenStatus = await fetch(`${url}/api/captures/status`, {
      headers: { Origin: "https://chatgpt.com" },
    });
    assert.equal(forbiddenStatus.status, 403);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("VS Code live events require host authentication and announce authoritative state changes", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-dev-bridge-events-"));
  const server = createServer(undefined, "test-vscode-token", undefined, path.join(directory, "chrome.token"), false, path.join(directory, "submissions.json"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  let reader;
  try {
    assert.equal((await fetch(`${url}/api/vscode/events`)).status, 401);
    assert.equal((await fetch(`${url}/api/vscode/events`, { headers: { Origin: origin, Authorization: "Bearer test-vscode-token" } })).status, 403);
    const stream = await fetch(`${url}/api/vscode/events`, { headers: { Authorization: "Bearer test-vscode-token", Accept: "text/event-stream" } });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type"), /text\/event-stream/);
    reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const posted = await fetch(`${url}/api/captures`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ ...capture, id: "event-capture" }),
    });
    assert.equal(posted.status, 200);
    for (let index = 0; index < 5 && !received.includes("capture.created"); index += 1) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += decoder.decode(chunk.value, { stream: true });
    }
    assert.match(received, /"type":"connected"/);
    assert.match(received, /"type":"capture\.created"/);
    assert.match(received, /"captureId":"event-capture"/);
    assert.doesNotMatch(received, /Untrusted captured text/);
  } finally {
    await reader?.cancel();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("live events announce submission lifecycle and approval decisions without prompt content", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-dev-bridge-lifecycle-events-"));
  const store = createCaptureStore();
  store.add({ ...capture, id: "lifecycle-capture", text: "sensitive prompt must not enter events" });
  class EventManager {
    async connect() {}
    async runPrompt() { await new Promise((resolve) => setTimeout(resolve, 20)); return { threadId: "event-thread", response: "done", status: "completed" }; }
    cancelCurrentTurn() {}
    getAllApprovals() { return []; }
    getStatus() { return { turnElapsedMs: 10, latestProgressEvent: { method: "turn/progress" }, turn: "running" }; }
  }
  const server = createServer(store, "test-vscode-token", () => new EventManager(), path.join(directory, "chrome.token"), true, path.join(directory, "submissions.json"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: "Bearer test-vscode-token", "Content-Type": "application/json" };
  let reader;
  try {
    const stream = await fetch(`${url}/api/vscode/events`, { headers });
    reader = stream.body.getReader();
    const submitted = await fetch(`${url}/api/vscode/codex/submit`, {
      method: "POST", headers, body: JSON.stringify({ captureId: "lifecycle-capture", workspace: process.cwd(), sandboxMode: "read-only" }),
    });
    assert.equal(submitted.status, 202);
    const submissionId = (await submitted.json()).submissionId;
    const simulated = await fetch(`${url}/api/vscode/codex/approvals/simulate`, {
      method: "POST", headers, body: JSON.stringify({ type: "file-change", workspace: process.cwd(), target: path.join(process.cwd(), "safe.txt") }),
    });
    const approval = await simulated.json();
    const denied = await fetch(`${url}/api/vscode/codex/approvals/decision`, {
      method: "POST", headers, body: JSON.stringify({ requestId: approval.requestId, connectionId: approval.connectionId, submissionId: approval.submissionId, decision: "deny" }),
    });
    assert.equal(denied.status, 200);
    let received = "";
    const decoder = new TextDecoder();
    for (let index = 0; index < 12 && (!received.includes("submission.completed") || !received.includes("approval.resolved")); index += 1) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += decoder.decode(chunk.value, { stream: true });
    }
    assert.match(received, /submission\.queued/);
    assert.match(received, /submission\.started/);
    assert.match(received, /submission\.completed/);
    assert.match(received, /approval\.requested/);
    assert.match(received, /approval\.resolved/);
    assert.match(received, new RegExp(submissionId));
    assert.doesNotMatch(received, /sensitive prompt/);
  } finally {
    await reader?.cancel();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("authenticated Codex submission uses stored capture text, reports completion, and rejects duplicates", async () => {
  const store = createCaptureStore();
  store.add(capture);
  const managers = [];
  class FakeManager {
    async connect() {}
    async runPrompt(prompt) {
      this.prompt = prompt;
      return { threadId: "thread-test", response: "Codex result", status: "completed" };
    }
    cancelCurrentTurn() { this.cancelled = true; }
    getPendingApprovals() { return this.pending || []; }
    getAllApprovals() { return this.pending || []; }
  }
  const tokenDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-dev-bridge-chrome-pair-"));
  const chromeTokenFile = path.join(tokenDirectory, "chrome.token");
  const stateFile = path.join(tokenDirectory, "submissions.json");
  const server = createServer(store, "test-vscode-token", () => {
    const manager = new FakeManager();
    managers.push(manager);
    return manager;
  }, chromeTokenFile, false, stateFile);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: "Bearer test-vscode-token", "Content-Type": "application/json" };

  try {
    const unconfirmedPair = await fetch(`${url}/api/codex/pair`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ confirm: false }),
    });
    assert.equal(unconfirmedPair.status, 400);

    const pair = await fetch(`${url}/api/codex/pair`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ confirm: true }),
    });
    assert.equal(pair.status, 200);
    const paired = await pair.json();
    assert.equal(paired.success, true);
    assert.equal(paired.paired, true);
    assert.equal(typeof paired.token, "string");
    assert.equal(fs.readFileSync(chromeTokenFile, "utf8").trim(), paired.token);

    const preflight = await fetch(`${url}/api/codex/latest`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
    assert.match(preflight.headers.get("access-control-allow-headers"), /Authorization/);

    const invalidToken = await fetch(`${url}/api/codex/latest`, {
      headers: { Origin: origin, Authorization: "Bearer invalid-token" },
    });
    assert.equal(invalidToken.status, 401);
    const originlessInvalidToken = await fetch(`${url}/api/codex/latest`, {
      headers: { Authorization: "Bearer invalid-token" },
    });
    assert.equal(originlessInvalidToken.status, 401);

    const browserAttempt = await fetch(`${url}/api/vscode/codex/submit`, {
      method: "POST",
      headers: { ...headers, Origin: "https://evil.example" },
      body: JSON.stringify({ captureId: capture.id, workspace: process.cwd() }),
    });
    assert.equal(browserAttempt.status, 403);

    const missingWorkspace = await fetch(`${url}/api/vscode/codex/submit`, {
      method: "POST", headers, body: JSON.stringify({ captureId: capture.id, workspace: "C:\\does-not-exist" }),
    });
    assert.equal(missingWorkspace.status, 400);

    const submitted = await fetch(`${url}/api/vscode/codex/submit`, {
      method: "POST", headers, body: JSON.stringify({ captureId: capture.id, workspace: process.cwd(), text: "attacker supplied text" }),
    });
    assert.equal(submitted.status, 202);
    const accepted = await submitted.json();
    assert.equal(accepted.success, true);
    assert.ok(["queued", "starting", "running"].includes(accepted.status));

    const status = await fetch(`${url}/api/vscode/codex/status/${accepted.submissionId}`, {
      headers: { Authorization: "Bearer test-vscode-token" },
    });
    assert.deepEqual(await status.json(), {
      success: true,
      submissionId: accepted.submissionId,
      captureId: capture.id,
      status: "completed",
      response: "Codex result",
      threadId: "thread-test",
    });
    assert.equal(managers[0].prompt, capture.text);
    managers[0].pending = [{ id: 1, type: "file-change", workspace: process.cwd(), status: "pending" }];
    const pendingApprovals = await fetch(`${url}/api/vscode/codex/approvals`, {
      headers: { Authorization: "Bearer test-vscode-token" },
    });
    assert.deepEqual(await pendingApprovals.json(), { success: true, approvals: managers[0].pending });

    const codexLatest = await fetch(`${url}/api/codex/latest`, {
      headers: { Origin: origin, Authorization: `Bearer ${paired.token}` },
    });
    const codexBody = await codexLatest.json();
    assert.equal(codexLatest.status, 200);
    assert.equal(codexBody.result.submissionId, accepted.submissionId);
    assert.equal(codexBody.result.threadId, "thread-test");
    assert.equal(codexBody.result.response, "Codex result");
    assert.equal(codexBody.result.status, "completed");
    assert.equal(codexBody.result.sourceConversationUrl, capture.conversationUrl);
    assert.ok(Date.parse(codexBody.result.timestamp));

    const originlessValid = await fetch(`${url}/api/codex/latest`, {
      headers: { Authorization: `Bearer ${paired.token}` },
    });
    assert.equal(originlessValid.status, 200);
    assert.deepEqual(await originlessValid.json(), { result: codexBody.result });

    const forbiddenCodexLatest = await fetch(`${url}/api/codex/latest`, {
      headers: { Origin: "https://chatgpt.com", Authorization: `Bearer ${paired.token}` },
    });
    assert.equal(forbiddenCodexLatest.status, 403);

    const duplicate = await fetch(`${url}/api/vscode/codex/submit`, {
      method: "POST", headers, body: JSON.stringify({ captureId: capture.id, workspace: process.cwd() }),
    });
    assert.equal(duplicate.status, 409);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(tokenDirectory, { recursive: true, force: true });
  }
});

test("simulated approval decisions require authentication and reject stale or mismatched requests", async () => {
  const tokenDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-dev-bridge-approval-"));
  const chromeTokenFile = path.join(tokenDirectory, "chrome.token");
  const stateFile = path.join(tokenDirectory, "submissions.json");
  const server = createServer(undefined, "test-vscode-token", undefined, chromeTokenFile, true);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: "Bearer test-vscode-token", "Content-Type": "application/json" };

  try {
    const unauthorized = await fetch(`${url}/api/vscode/codex/approvals/simulate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "command-execution", workspace: process.cwd() }),
    });
    assert.equal(unauthorized.status, 401);

    const simulated = await fetch(`${url}/api/vscode/codex/approvals/simulate`, {
      method: "POST", headers, body: JSON.stringify({
        type: "command-execution", command: "echo harmless", reason: "test only", workspace: process.cwd(),
      }),
    });
    assert.equal(simulated.status, 201);
    const created = await simulated.json();

    const listed = await fetch(`${url}/api/vscode/codex/approvals`, { headers });
    const listedBody = await listed.json();
    const record = listedBody.approvals.find((item) => item.id === created.requestId);
    assert.equal(record.workspace, process.cwd());
    assert.equal(record.status, "pending");
    assert.equal(record.connectionId, created.connectionId);

    const wrongBinding = await fetch(`${url}/api/vscode/codex/approvals/decision`, {
      method: "POST", headers, body: JSON.stringify({
        requestId: created.requestId, connectionId: created.connectionId,
        submissionId: "wrong-submission", decision: "deny",
      }),
    });
    assert.equal(wrongBinding.status, 409);

    const approved = await fetch(`${url}/api/vscode/codex/approvals/decision`, {
      method: "POST", headers, body: JSON.stringify({
        requestId: created.requestId, connectionId: created.connectionId,
        submissionId: created.submissionId, decision: "approve",
      }),
    });
    assert.deepEqual(await approved.json(), { success: true, decision: "approved", simulated: true });

    const stale = await fetch(`${url}/api/vscode/codex/approvals/decision`, {
      method: "POST", headers, body: JSON.stringify({
        requestId: created.requestId, connectionId: created.connectionId,
        submissionId: created.submissionId, decision: "deny",
      }),
    });
    assert.equal(stale.status, 409);

    const second = await fetch(`${url}/api/vscode/codex/approvals/simulate`, {
      method: "POST", headers, body: JSON.stringify({
        type: "file-change", target: path.join(process.cwd(), "safe.txt"), workspace: process.cwd(),
      }),
    });
    const secondCreated = await second.json();
    const denied = await fetch(`${url}/api/vscode/codex/approvals/decision`, {
      method: "POST", headers, body: JSON.stringify({
        requestId: secondCreated.requestId, connectionId: secondCreated.connectionId,
        submissionId: secondCreated.submissionId, decision: "deny",
      }),
    });
    assert.deepEqual(await denied.json(), { success: true, decision: "denied", simulated: true });

    const deniedReplay = await fetch(`${url}/api/vscode/codex/approvals/decision`, {
      method: "POST", headers, body: JSON.stringify({
        requestId: secondCreated.requestId, connectionId: secondCreated.connectionId,
        submissionId: secondCreated.submissionId, decision: "deny",
      }),
    });
    assert.equal(deniedReplay.status, 409);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(tokenDirectory, { recursive: true, force: true });
  }
});

test("automation submits each new matching capture once in the selected workspace mode", async () => {
  const store = createCaptureStore();
  const tokenDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-dev-bridge-automation-"));
  const chromeTokenFile = path.join(tokenDirectory, "chrome.token");
  const stateFile = path.join(tokenDirectory, "submissions.json");
  const managers = [];
  class AutomationManager {
    constructor(options) { this.options = options; }
    async connect() {}
    async runPrompt(prompt) { this.prompt = prompt; return { threadId: "automation-thread", response: "tests passed", status: "completed", events: [{ method: "item/completed", status: "completed" }] }; }
    cancelCurrentTurn() {}
    getAllApprovals() { return []; }
    getConnectionId() { return "automation-connection"; }
  }
  const server = createServer(store, "test-vscode-token", (options) => { const manager = new AutomationManager(options); managers.push(manager); return manager; }, chromeTokenFile, false, stateFile);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  const vscodeHeaders = { Authorization: "Bearer test-vscode-token", "Content-Type": "application/json" };
  const capture = { id: "automation-response", text: "Implement the harmless task", timestamp: new Date().toISOString(), conversationUrl: "https://chatgpt.com/c/automation" };
  try {
    const configured = await fetch(`${url}/api/vscode/codex/automation`, { method: "POST", headers: vscodeHeaders, body: JSON.stringify({ enabled: true, workspace: process.cwd(), conversationUrl: capture.conversationUrl, sandboxMode: "workspace-write" }) });
    assert.equal(configured.status, 200);
    const otherConversation = { ...capture, id: "other-tab-response", conversationUrl: "https://chatgpt.com/g/g-custom/c/other" };
    const ignored = await fetch(`${url}/api/captures`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(otherConversation) });
    assert.deepEqual(await ignored.json(), { success: true, duplicate: false, automation: { decision: "skipped", reason: "conversation_mismatch" } });
    const first = await fetch(`${url}/api/captures`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(capture) });
    const firstBody = await first.json();
    assert.equal(firstBody.success, true);
    assert.equal(typeof firstBody.submissionId, "string");
    assert.equal(managers[0].options.sandboxMode, "workspace-write");
    assert.equal(managers[0].options.allowApprovals, true);
    const duplicate = await fetch(`${url}/api/captures`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(capture) });
    assert.deepEqual(await duplicate.json(), { success: true, duplicate: true, automation: { decision: "skipped", reason: "duplicate" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const status = await fetch(`${url}/api/vscode/codex/status/${firstBody.submissionId}`, { headers: { Authorization: "Bearer test-vscode-token" } });
    const statusBody = await status.json();
    assert.equal(statusBody.status, "completed");
    assert.deepEqual(statusBody.events, [{ method: "item/completed", status: "completed" }]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(tokenDirectory, { recursive: true, force: true });
  }
});

test("automation activation distinguishes workspace and conversation validation failures", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-dev-bridge-automation-validation-"));
  const server = createServer(undefined, "test-vscode-token", undefined, path.join(directory, "chrome.token"), false, path.join(directory, "submissions.json"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: "Bearer test-vscode-token", "Content-Type": "application/json" };
  try {
    const invalidUrl = await fetch(`${url}/api/vscode/codex/automation`, { method: "POST", headers, body: JSON.stringify({ enabled: true, workspace: process.cwd(), conversationUrl: "https://chatgpt.com/g/g-custom", sandboxMode: "read-only" }) });
    assert.equal(invalidUrl.status, 400);
    assert.match((await invalidUrl.json()).error, /valid ChatGPT conversation URL/);

    const untrusted = await fetch(`${url}/api/vscode/codex/automation`, { method: "POST", headers, body: JSON.stringify({ enabled: true, workspace: directory, conversationUrl: "https://chatgpt.com/g/g-custom/c/custom-id", sandboxMode: "read-only" }) });
    assert.equal(untrusted.status, 400);
    assert.match((await untrusted.json()).error, /not trusted or allowlisted/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("retries only confirmed failures and recovers uncertain work without replay", async () => {
  const store = createCaptureStore();
  const capture = { id: "retry-capture", text: "retry this harmless task", timestamp: new Date().toISOString(), conversationUrl: "https://chatgpt.com/c/retry" };
  store.add(capture);
  const tokenDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-dev-bridge-retry-"));
  const stateFile = path.join(tokenDirectory, "submissions.json");
  let calls = 0;
  class RetryManager {
    async connect() {}
    async runPrompt() { calls += 1; if (calls === 1) throw new Error("spawn codex ENOENT"); return { threadId: "retry-thread", response: "retry completed", status: "completed" }; }
    cancelCurrentTurn() {}
    getAllApprovals() { return []; }
  }
  const server = createServer(store, "test-vscode-token", () => new RetryManager(), path.join(tokenDirectory, "chrome.token"), false, stateFile);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: "Bearer test-vscode-token", "Content-Type": "application/json" };
  try {
    const submitted = await fetch(`${url}/api/vscode/codex/submit`, { method: "POST", headers, body: JSON.stringify({ captureId: capture.id, workspace: process.cwd(), sandboxMode: "read-only" }) });
    const first = await submitted.json();
    let statusBody;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      statusBody = await (await fetch(`${url}/api/vscode/codex/status/${first.submissionId}`, { headers })).json();
      if (statusBody.status !== "starting" && statusBody.status !== "running") break;
    }
    assert.equal(statusBody.status, "failed");
    assert.match(statusBody.error, /spawn codex ENOENT/);
    const retry = await fetch(`${url}/api/vscode/codex/retry`, { method: "POST", headers, body: JSON.stringify({ submissionId: first.submissionId }) });
    const retried = await retry.json();
    assert.equal(retry.status, 202);
    assert.notEqual(retried.submissionId, first.submissionId);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      statusBody = await (await fetch(`${url}/api/vscode/codex/status/${retried.submissionId}`, { headers })).json();
      if (statusBody.status !== "starting" && statusBody.status !== "running") break;
    }
    assert.equal(statusBody.status, "completed");
    const history = await (await fetch(`${url}/api/vscode/codex/submissions`, { headers })).json();
    assert.equal(history.submissions.some((item) => item.id === first.submissionId), true);
    assert.equal(history.submissions.some((item) => item.id === retried.submissionId && item.parentSubmissionId === first.submissionId), true);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(tokenDirectory, { recursive: true, force: true });
  }

  const recoveryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-dev-bridge-recovery-"));
  const recoveryState = path.join(recoveryDirectory, "submissions.json");
  fs.writeFileSync(recoveryState, JSON.stringify([{ id: "uncertain-1", captureId: "old", workspace: process.cwd(), sandboxMode: "workspace-write", status: "running", sourceConversationUrl: "https://chatgpt.com/c/retry" }]));
  const recoveryServer = createServer(undefined, "test-vscode-token", undefined, path.join(recoveryDirectory, "chrome.token"), false, recoveryState);
  await new Promise((resolve) => recoveryServer.listen(0, "127.0.0.1", resolve));
  const recoveryAddress = recoveryServer.address();
  try {
    const history = await (await fetch(`http://127.0.0.1:${recoveryAddress.port}/api/vscode/codex/submissions`, { headers: { Authorization: "Bearer test-vscode-token" } })).json();
    assert.equal(history.submissions[0].status, "failed");
    assert.equal(history.submissions[0].uncertain, true);
  } finally {
    await new Promise((resolve, reject) => recoveryServer.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(recoveryDirectory, { recursive: true, force: true });
  }
});

test("active-writer conflict recovery preserves history, retries atomically, and remains blocked when ownership persists", async () => {
  const createFixture = async (name, alwaysConflict = false) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `ai-dev-bridge-${name}-`));
    const store = createCaptureStore();
    const conflictCapture = { ...capture, id: `${name}-capture`, conversationUrl: `https://chatgpt.com/c/${name}` };
    store.add(conflictCapture);
    const managers = [];
    let released = false;
    class ConflictManager {
      async connect() {}
      async runPrompt() {
        if (alwaysConflict || !released) throw new Error("RPC -32600: thread already has an active writer");
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { threadId: "preserved-thread", response: "recovered", status: "completed" };
      }
      cancelCurrentTurn() {}
      getAllApprovals() { return []; }
      getStatus() { return { turn: "idle" }; }
    }
    const server = createServer(store, "test-vscode-token", () => { const manager = new ConflictManager(); managers.push(manager); return manager; }, path.join(directory, "chrome.token"), false, path.join(directory, "submissions.json"));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}`;
    const headers = { Authorization: "Bearer test-vscode-token", "Content-Type": "application/json" };
    const submit = await fetch(`${url}/api/vscode/codex/submit`, { method: "POST", headers, body: JSON.stringify({ captureId: conflictCapture.id, workspace: process.cwd(), sandboxMode: "read-only" }) });
    const first = await submit.json();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const status = await (await fetch(`${url}/api/vscode/codex/status/${first.submissionId}`, { headers: { Authorization: "Bearer test-vscode-token" } })).json();
      if (status.status === "failed") break;
    }
    return { directory, store, conflictCapture, managers, setReleased: () => { released = true; }, server, url, headers, first };
  };

  const resolved = await createFixture("conflict-resolved");
  try {
    const original = await (await fetch(`${resolved.url}/api/vscode/codex/status/${resolved.first.submissionId}`, { headers: { Authorization: "Bearer test-vscode-token" } })).json();
    assert.equal(original.status, "failed");
    assert.equal(original.blocked, true);
    const persistedBeforeRecovery = JSON.parse(fs.readFileSync(path.join(resolved.directory, "submissions.json"), "utf8"));
    assert.equal(persistedBeforeRecovery[0].captureSnapshot.text, resolved.conflictCapture.text);
    const unconfirmed = await fetch(`${resolved.url}/api/vscode/codex/retry-after-conflict`, { method: "POST", headers: resolved.headers, body: JSON.stringify({ submissionId: resolved.first.submissionId }) });
    assert.equal(unconfirmed.status, 400);
    resolved.setReleased();
    const requests = await Promise.all([0, 1].map(() => fetch(`${resolved.url}/api/vscode/codex/retry-after-conflict`, { method: "POST", headers: resolved.headers, body: JSON.stringify({ submissionId: resolved.first.submissionId, confirmConflict: true }) })));
    assert.deepEqual(requests.map((response) => response.status).sort(), [202, 409]);
    const accepted = await (await Promise.all(requests.map((response) => response.clone().json()))).find((body) => body.success === true);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const status = await (await fetch(`${resolved.url}/api/vscode/codex/status/${accepted.submissionId}`, { headers: { Authorization: "Bearer test-vscode-token" } })).json();
      if (status.status === "completed") { assert.equal(status.threadId, "preserved-thread"); break; }
    }
    const history = await (await fetch(`${resolved.url}/api/vscode/codex/submissions`, { headers: { Authorization: "Bearer test-vscode-token" } })).json();
    assert.equal(history.submissions.some((item) => item.id === resolved.first.submissionId && item.blocked), true);
    assert.equal(history.submissions.some((item) => item.parentSubmissionId === resolved.first.submissionId && item.status === "completed"), true);
    assert.equal(history.submissions.every((item) => item.captureSnapshot === undefined), true);
    assert.equal(resolved.managers.length, 1);
  } finally {
    await new Promise((resolve, reject) => resolved.server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(resolved.directory, { recursive: true, force: true });
  }

  const persistent = await createFixture("conflict-persistent", true);
  try {
    const retried = await fetch(`${persistent.url}/api/vscode/codex/retry-after-conflict`, { method: "POST", headers: persistent.headers, body: JSON.stringify({ submissionId: persistent.first.submissionId, confirmConflict: true }) });
    assert.equal(retried.status, 202);
    const retry = await retried.json();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const status = await (await fetch(`${persistent.url}/api/vscode/codex/status/${retry.submissionId}`, { headers: { Authorization: "Bearer test-vscode-token" } })).json();
      if (status.status === "failed") { assert.equal(status.blocked, true); assert.match(status.error, /writer/i); break; }
    }
  } finally {
    await new Promise((resolve, reject) => persistent.server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(persistent.directory, { recursive: true, force: true });
  }
});
