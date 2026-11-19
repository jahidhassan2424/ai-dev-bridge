const assert = require("node:assert/strict");
const test = require("node:test");
const poc = require("../dist/codex-app-server-poc.js");

test("builds the initialization handshake without thread or turn methods", () => {
  const request = poc.initializeRequest();
  assert.deepEqual(request, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { clientInfo: { name: "ai-dev-bridge", title: "AI Dev Bridge", version: "1.0.0" } },
  });
  assert.deepEqual(poc.initializedNotification(), { jsonrpc: "2.0", method: "initialized", params: {} });
  assert.doesNotMatch(poc.encodeMessage(request), /thread\/start|turn\/start/);
});

test("rejects malformed JSON-RPC lines", () => {
  assert.throws(() => poc.parseJsonRpcLine("not json"), /malformed JSON/);
  assert.throws(() => poc.parseJsonRpcLine("[]"), /non-object/);
});

test("builds documented read-only thread and turn requests", () => {
  const thread = poc.threadStartRequest("C:/bridge-project");
  assert.equal(thread.method, "thread/start");
  assert.deepEqual(thread.params, {
    cwd: "C:/bridge-project",
    approvalPolicy: "on-request",
    sandbox: "read-only",
    threadSource: "appServer",
  });

  const turn = poc.turnStartRequest("thread-1");
  assert.equal(turn.method, "turn/start");
  assert.deepEqual(turn.params, {
    threadId: "thread-1",
    input: [{ type: "text", text: "Reply with exactly: Codex bridge connected." }],
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  });
});

test("extracts only agent deltas and successful completion status", () => {
  assert.equal(poc.agentMessageDelta({ method: "item/agentMessage/delta", params: { threadId: "t", delta: "hello" } }, "t"), "hello");
  assert.equal(poc.agentMessageDelta({ method: "item/agentMessage/delta", params: { threadId: "other", delta: "no" } }, "t"), undefined);
  assert.equal(poc.completionStatus({ method: "turn/completed", params: { turn: { status: "completed" } } }), "completed");
  assert.equal(poc.completionStatus({ method: "turn/started", params: { turn: { status: "completed" } } }), undefined);
});

test("persists only the bridge-owned thread ID", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-dev-bridge-poc-"));
  try {
    const file = path.join(directory, "thread-id");
    poc.persistThreadId("thread-123", file);
    assert.equal(fs.readFileSync(file, "utf8"), "thread-123\n");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
